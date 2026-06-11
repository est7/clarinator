import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the React app into ONE self-contained dist/clarity.html (no external
// assets, no network fonts). The server injects the runtime payload by replacing
// the </head> sentinel at launch, so the committed HTML stays payload-free.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
    // viteSingleFile inlines JS+CSS into dist/index.html; the build script then
    // renames it to dist/clarity.html (the name the server reads).
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    target: "esnext",
  },
});
