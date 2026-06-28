import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "@common": resolve(__dirname, "common"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
