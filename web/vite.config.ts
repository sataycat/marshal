/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

const analyze = process.env.ANALYZE === "1";

export default defineConfig({
  plugins: [
    react(),
    analyze &&
      visualizer({
        filename: "dist/stats.html",
        template: "treemap",
        gzipSize: true,
        brotliSize: false,
        open: false,
      }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:7433", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:7433", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
