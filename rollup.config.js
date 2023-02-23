import { defineConfig } from "rollup";
import cleaner from "rollup-plugin-cleaner";
import externals from "rollup-plugin-node-externals";

export default defineConfig({
    input: "src/dymo-services.js",
    output: [
        {
            file: "./dist/index.cjs",
            format: "cjs",
            exports: "named",
            sourcemap: true,
        },
        {
            file: "./dist/index.mjs",
            format: "es",
            exports: "named",
            sourcemap: true,
        },
    ],
    plugins: [cleaner({ targets: ["./dist"] }), externals()],
});
