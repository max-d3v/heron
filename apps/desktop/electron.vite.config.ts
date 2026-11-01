import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages export TypeScript source, so they're bundled; third-party
// dependencies stay external and ship in node_modules.
const workspace = ["@heron/core", "@heron/db", "@heron/git", "@heron/github", "@heron/harness", "@heron/platform", "@heron/rpc"];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspace },
      rollupOptions: { input: { index: resolve(import.meta.dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads must be CommonJS.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, "src/renderer/index.html") } },
    },
  },
});
