import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(process.cwd(), "src/renderer"),
  plugins: [react()],
  build: {
    outDir: resolve(process.cwd(), "dist-sandbox/renderer"),
    emptyOutDir: false
  }
});
