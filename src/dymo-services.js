import Jimp from "jimp";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { convertImageToBitmap } from "./image-services.js";
import { execute } from "./system-services.js";

// Technical specifications Dymo LabelWriter 450.
// https://download.dymo.com/dymo/user-guides/LabelWriter/LWSE450/LWSE450_TechnicalReference.pdf

// Returns the printer to its power-up condition, clears all buffers, and resets all character attributes.
// The ESC @ command is the same as the ESC * command.
const CMD_RESET = Buffer.from([0x1b, "*".charCodeAt(0)]);
// Feed to Tear Position. This command advances the most recently printed label to a position where it can be torn off.
const CMD_FULL_FORM_FEED = Buffer.from([0x1b, "E".charCodeAt(0)]);
// Feed to Print Head. Use this command when printing multiple labels.
const CMD_SHORT_FORM_FEED = Buffer.from([0x1b, "G".charCodeAt(0)]);
const CMD_TEXT_SPEED_MODE = Buffer.from([0x1b, "h".charCodeAt(0)]);
const CMD_DENSITY_NORMAL = Buffer.from([0x1b, "e".charCodeAt(0)]);
const CMD_NO_DOT_TAB = Buffer.from([0x1b, "B".charCodeAt(0), 0]);

// To reset the printer after a synchronization error or to recover from an unknown state, the host computer needs
// to send at least 85 continuous <esc> characters to the printer. This 85-character sequence is required in case the
// printer is in a mode in which it expects a raster line of data. The 85 <esc> characters exceed the default number
// of bytes required for a full line of raster data (84); this ensures that the printer looks for an ESC command.
// https://download.dymo.com/dymo/technical-data-sheets/LW%20450%20Series%20Technical%20Reference.pdf
const CMD_START_ESC = Buffer.from(new Array(313).fill(0x1b));

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const PRINTER_INTERFACE_CUPS = "CUPS";
const PRINTER_INTERFACE_NETWORK = "NETWORK";
const PRINTER_INTERFACE_WINDOWS = "WINDOWS";
const PRINTER_INTERFACE_DEVICE = "DEVICE";

/**
 * @typedef {Object} PrinterConfig
 * @property {string} [interface] Printer interface (CUPS, NETWORK, WINDOWS, DEVICE)
 * @property {string} [host] Printer host name or IP address
 * @property {number} [port] Printer port
 * @property {string} [deviceId] Printer device ID
 * @property {string} [device] Printer device name
 */

/**
 * Create service that connects to configured DYMO LabelWriter.
 * If no configuration found, try to find the DYMO printer. First one found is used.
 */
export class DymoServices {
    /**
     * Dymo 99010 labels S0722370 compatible , 89mm x 28mm (3.5inch x 1.1inch, 300dpi).
     */
    static DYMO_LABELS = {
        "89mm x 28mm": {
            title: "89mm x 28mm",
            imageWidth: 964,
            imageHeight: 300,
        },
        "89mm x 36mm": {
            title: "89mm x 36mm",
            imageWidth: 964,
            imageHeight: 390,
        },
        "54mm x 25mm": {
            title: "54mm x 25mm",
            imageWidth: 584,
            imageHeight: 270,
        },
    };

    /**
     * @private
     * @type {PrinterConfig}
     */
    config = {};
    /**
     * @private
     * @type {Buffer[]}
     */
    chunks = [];

    /**
     * Create new DymoServices instance.
     *
     * @param {PrinterConfig} [config] Optional printer configuration
     */
    constructor(config = undefined) {
        if (config) {
            Object.assign(this.config, config);
            DymoServices.validateConfig(this.config);
        }
    }

    /**
     * Print the image.
     * The size of the image should match the size of the label.
     *
     * @param {Jimp} image image object in landscape orientation
     * @param {number} [printCount] Number of prints (defaults to 1)
     * @return {Promise<void>} Resolves in case of success, rejects otherwise
     */
    print(image, printCount = 1) {
        return new Promise((resolve, reject) => {
            convertImageToBitmap(image)
                .then((bitmapImageBuffer) => {
                    this.printBitmap(bitmapImageBuffer, printCount).then(resolve).catch(reject);
                })
                .catch(reject);
        });
    }

    /**
     * List all available system printers.
     *
     * @return {Promise<{deviceId:string,name:string}[]>} List of printers or empty list
     */
    listPrinters() {
        if (IS_WINDOWS) {
            return DymoServices.listPrintersWindows();
        }
        if (IS_MACOS || IS_LINUX) {
            return DymoServices.listPrintersMacLinux();
        }
        return Promise.reject("Cannot list printers, unsupported operating system: " + process.platform);
    }

    /**
     * @private
     *
     * Print the bitmap image buffer.
     * The size of the image should match the size of the label.
     *
     * @param {number[][]} imageBuffer Bitmap image array, lines and rows in portrait orientation
     * @param {number} [printCount] Number of prints
     * @return {Promise<void>} Resolves in case of success, rejects otherwise
     */
    printBitmap(imageBuffer, printCount = 1) {
        if (!imageBuffer || imageBuffer.length === 0) {
            throw Error("Empty imageBuffer, cannot print");
        }
        if (printCount <= 0) {
            throw Error(`PrintCount cannot be 0 or a negative number: ${printCount}`);
        }

        // Determine the label dimensions based on the bitmap image buffer.
        const labelLineWidth = imageBuffer[0].length * 8;
        const labelLength = imageBuffer.length;
        this.init(labelLineWidth, labelLength);

        for (let count = 1; count <= printCount; count++) {
            // Convert bitmap array to printer bitmap.
            for (let i = 0; i < imageBuffer.length; i++) {
                this.append(Buffer.from([0x16, ...imageBuffer[i]]));
            }
            if (count === printCount) {
                // End print job.
                this.append(CMD_FULL_FORM_FEED);
            } else {
                this.append(CMD_SHORT_FORM_FEED);
            }
        }

        return this.sendDataToPrinter();
    }

    /**
     * @private
     *
     * Initialize the buffer and the printer configuration.
     *
     * @param {number} labelLineWidth The width the print head has to print, number of dots (300 dots per inch)
     * @param {number} labelLength Number of lines to print (300 lines per inch)
     */
    init(labelLineWidth, labelLength) {
        this.clear();

        // To reset the printer after a synchronization error or to recover from an unknown state, the host computer
        // needs to send at least 85 continuous <esc> characters to the printer.
        this.append(CMD_START_ESC);
        this.append(CMD_RESET);

        // <esc> B n Set Dot Tab
        // This command shifts the starting dot position on the print head towards the right
        this.append(CMD_NO_DOT_TAB);

        // <esc> D n Set Bytes per Line
        // This command reduces the number of bytes sent for each line.
        // E.g. 332 pixels (will be 336 dots, 42 * 8).
        const labelLineWidthBytes = Math.ceil(labelLineWidth / 8);
        this.append(Buffer.from([0x1b, "D".charCodeAt(0), labelLineWidthBytes]));

        // At power up, the label length variable is set to a default value of 3058 (in 300ths of an inch units),
        // which corresponds to approximately 10.2 inches. The Set Label Length command sequence (<esc> L nl n2)
        // allows the host software to change the label length variable to accommodate longer lengths.

        // <esc> L nl n2 Set Label Length
        // This command indicates the maximum distance the printer should travel while searching for the
        // top-of-form hole or mark.
        // E.g. 1052 pixels
        const lsb = labelLength & 0xff;
        const msb = (labelLength >> 8) & 0xff;
        this.append(Buffer.from([0x1b, "L".charCodeAt(0), msb, lsb]));

        // <esc> h Text Speed Mode (300x300 dpi)
        // This command instructs the printer to print in 300 x 300 dpi Text Quality mode.
        // This is the default, high speed printing mode.
        this.append(CMD_TEXT_SPEED_MODE);

        // <esc> e Set Print Density Normal
        // This command sets the strobe time of the printer to 100% of its standard duty cycle.
        this.append(CMD_DENSITY_NORMAL);
    }

    /**
     * @private
     *
     * Send the data to the printer.
     *
     * @return {Promise<void>} Resolves in case of success, rejects otherwise
     */
    sendDataToPrinter() {
        return new Promise((resolve, reject) => {
            const buffer = Buffer.concat(this.chunks);
            const printerInterface = this.config.interface;

            if (!printerInterface) {
                // Try to guess what printer to use.
                this.listPrinters()
                    .then((printers) => {
                        // Use the first match for "LabelWriter 450".
                        const printer = printers.find((printer) => {
                            return printer.name && printer.name.toLowerCase().indexOf("dymo") !== -1;
                        });
                        if (!printer) {
                            reject("Cannot find Dymo LabelWriter. Try to configure manually.");
                            return;
                        }
                        // Found a Dymo label writer.
                        this.config.interface = IS_WINDOWS ? PRINTER_INTERFACE_WINDOWS : PRINTER_INTERFACE_CUPS;
                        this.config.deviceId = printer.deviceId;
                        this.sendDataToPrinter().then(resolve).catch(reject);
                    })
                    .catch(reject);
                return;
            }

            if (printerInterface === PRINTER_INTERFACE_NETWORK) {
                DymoServices.sendDataToNetworkPrinter(buffer, this.config.host, this.config.port)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            if (printerInterface === PRINTER_INTERFACE_CUPS) {
                DymoServices.sendDataToCupsPrinter(buffer, /** @type {string} */ (this.config.deviceId)).then(resolve).catch(reject);
                return;
            }
            if (printerInterface === PRINTER_INTERFACE_WINDOWS) {
                DymoServices.sendDataToWindowsPrinter(buffer, /** @type {string} */ (this.config.deviceId)).then(resolve).catch(reject);
                return;
            }
            if (printerInterface === PRINTER_INTERFACE_DEVICE) {
                DymoServices.sendDataToDevicePrinter(buffer, /** @type {string} */ (this.config.device)).then(resolve).catch(reject);
                return;
            }
            throw Error(`Unknown printer interface configured: "${printerInterface}"`);
        });
    }

    /**
     * @private
     * Clear the print buffer.
     */
    clear() {
        this.chunks.length = 0;
    }

    /**
     * @private
     * Append given buffer to the print buffer.
     *
     * @param {Buffer} buff Buffer to add
     */
    append(buff) {
        if (!Buffer.isBuffer(buff)) {
            throw Error("append() called with type other than Buffer: " + typeof buff);
        }
        this.chunks.push(buff);
    }

    /**
     * @private
     *
     * Validate the configuration.
     * Throw error in case of configuration error.
     *
     * @param {PrinterConfig} config Config object
     */
    static validateConfig(config) {
        const INTERFACES = [
            PRINTER_INTERFACE_NETWORK,
            PRINTER_INTERFACE_CUPS,
            PRINTER_INTERFACE_WINDOWS,
            PRINTER_INTERFACE_DEVICE,
        ];
        if (config.interface && INTERFACES.indexOf(config.interface) === -1) {
            throw Error(`Invalid interface "${config.interface}", valid interfaces are: ${INTERFACES.join(", ")}`);
        }
    }

    /**
     * @private
     *
     * Send data to network printer.
     *
     * @param {Buffer} buffer Printer data buffer
     * @param {string} host Hostname or IP address (defaults to localhost)
     * @param {number} port Port number (defaults to 9100)
     * @return {Promise<void>} Resolves in case of success, rejects otherwise
     */
    static sendDataToNetworkPrinter(buffer, host = "localhost", port = 9100) {
        return new Promise((resolve, reject) => {
            const networkPrinter = net.connect({ host, port, timeout: 30000 }, function () {
                networkPrinter.write(buffer, "binary", () => {
                    networkPrinter.end();
                    resolve();
                });
            });

            networkPrinter.on("error", (err) => {
                networkPrinter.end();
                reject(err);
            });

            networkPrinter.on("timeout", () => {
                networkPrinter.end();
                reject("Timeout connecting to printer.");
            });
        });
    }

    /**
     * @private
     *
     * Send data to USB (device) printer.
     *
     * @param {Buffer} buffer Printer data buffer
     * @param {string} device Device location /dev/usb/lp0
     * @return {Promise<void>} Resolves in case of success, rejects otherwise
     */
    static sendDataToDevicePrinter(buffer, device) {
        return new Promise((resolve, reject) => {
            if (!device) {
                throw Error("Cannot write to device, the device name is empty");
            }
            fs.writeFile(device, buffer, { encoding: "binary" }, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    /**
     * @private
     *
     * Send data to CUPS printer.
     *
     * @param {Buffer} buffer Printer data buffer
     * @param {string} deviceId CUPS device id
     * @return {Promise<void>} Resolves in case of success, rejects otherwise
     */
    static sendDataToCupsPrinter(buffer, deviceId) {
        return new Promise((resolve, reject) => {
            if (!deviceId) {
                throw Error("Cannot print to CUPS printer, deviceId is not configured.");
            }
            execute("lp", ["-d", `${deviceId}`], buffer)
                .then(() => resolve())
                .catch(reject);
        });
    }

    /**
     * @private
     *
     * Send data to Windows RAW printer.
     *
     * @param {Buffer} buffer Printer data buffer
     * @param {string} deviceId Windows printer device id
     * @return {Promise<void>} Resolves in case of success, rejects otherwise
     */
    static sendDataToWindowsPrinter(buffer, deviceId) {
        // > RawPrint "Name of Your Printer" filename
        // http://www.columbia.edu/~em36/windowsrawprint.html
        // https://github.com/frogmorecs/RawPrint
        return new Promise((resolve, reject) => {
            const tmp = DymoServices.tmpFile();
            fs.writeFileSync(tmp, buffer, { encoding: "binary" });
            execute(path.join(__dirname, "RP.exe"), [deviceId, tmp], buffer)
                .then(() => {
                    fs.unlinkSync(tmp);
                    resolve();
                })
                .catch(reject);
        });
    }

    /**
     * @private
     *
     * Get list of installed printers.
     *
     * @return {Promise<{deviceId:string,name:string}[]>} List of printers or empty list
     */
    static listPrintersMacLinux() {
        return new Promise((resolve, reject) => {
            execute("lpstat", ["-e"])
                .then((stdout) => {
                    const printers = stdout
                        .split("\n")
                        .filter((row) => !!row.trim())
                        .map((row) => {
                            return {
                                deviceId: row.trim(),
                                name: row.replace(/_+/g, " ").trim(),
                            };
                        });

                    // Try to find the name ("Description:") of every printer found.
                    /** @type {Promise[]} */
                    const promises = [];
                    printers.forEach((printer) => {
                        promises.push(execute("lpstat", ["-l", "-p", printer.deviceId]));
                    });

                    // Update the name for every printer description found.
                    Promise.allSettled(promises).then((results) => {
                        results.forEach((result, idx) => {
                            if (result.status === "fulfilled" && result.value) {
                                const description = result.value
                                    .split("\n")
                                    .filter((line) => /^description:/gi.test(line.trim()))
                                    .map((line) => line.replace(/description:/gi, "").trim())
                                    .find((line) => !!line);
                                if (description) {
                                    printers[idx].name = description;
                                }
                            }
                        });
                        resolve(printers);
                    });
                })
                .catch(reject);
        });
    }

    /**
     * @private
     *
     * Get list of installed printers.
     *
     * @return {Promise<{deviceId:string,name:string}[]>} List of printers or empty list
     */
    static listPrintersWindows() {
        return new Promise((resolve, reject) => {
            execute("Powershell.exe", ["-Command", "Get-CimInstance Win32_Printer -Property DeviceID,Name"])
                .then((stdout) => {
                    resolve(DymoServices.stdoutHandler(stdout));
                })
                .catch(reject);
        });
    }

    /**
     * @private
     *
     * Parse "Get-CimInstance Win32_Printer" output.
     *
     * @param stdout Process output
     * @return {{deviceId:string,name:string}[]} List of printers or empty list
     */
    static stdoutHandler(stdout) {
        const printers = [];
        stdout
            .split(/(\r?\n){2,}/)
            .map((printer) => printer.trim())
            .filter((printer) => !!printer)
            .forEach((printer) => {
                const { isValid, printerData } = DymoServices.isValidPrinter(printer);
                if (!isValid) {
                    return;
                }
                printers.push(printerData);
            });

        return printers;
    }

    /**
     * @private
     *
     * Return only the printers with deviceid and name.
     *
     * @param printer
     * @return {{isValid: boolean, printerData: {name: string, deviceId: string}}}
     */
    static isValidPrinter(printer) {
        const printerData = {
            deviceId: "",
            name: "",
        };

        const isValid = printer.split(/\r?\n/).some((line) => {
            const [label, value] = line.split(":").map((el) => el.trim());
            const lowerLabel = label.toLowerCase();
            if (lowerLabel === "deviceid") printerData.deviceId = value;
            if (lowerLabel === "name") printerData.name = value;
            return !!(printerData.deviceId && printerData.name);
        });

        return {
            isValid,
            printerData,
        };
    }

    /**
     * @private
     *
     * Create tmp filename.
     * https://stackoverflow.com/questions/7055061/nodejs-temporary-file-name
     *
     * @param {string} [prefix]
     * @param {string} [suffix]
     * @param {string} [tmpdir] optional, uses OS temp dir by default
     * @return {string} Absolute filename temp file
     */
    static tmpFile(prefix, suffix, tmpdir) {
        prefix = typeof prefix !== "undefined" ? prefix : "tmp.";
        suffix = typeof suffix !== "undefined" ? suffix : "";
        tmpdir = tmpdir ? tmpdir : os.tmpdir();
        return path.join(tmpdir, prefix + crypto.randomBytes(16).toString("hex") + suffix);
    }
}

// Make those imageService functions available via this file.
export { createImageWithText } from "./image-services.js";
