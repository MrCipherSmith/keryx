import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { assetsInlineLimit: 0, sourcemap: false, target: "es2022" },
  server: {
    // The quick-start dialog shares the mode templates with the hub (../../src/hub/work).
    fs: { allow: ["../.."] },
    proxy: {
      "/hub/work/v1": {
        target: process.env.HUB_DEV_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: false,
      },
      "/hub/v2": {
        target: process.env.HUB_DEV_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: false,
        ws: true,
      },
      "/hub/v1": {
        target: process.env.HUB_DEV_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
