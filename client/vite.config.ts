import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.FIELD_API_TARGET || "http://localhost:19200",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Public source maps let Sentry show browser errors against the real
    // source without an upload token. The source is public already.
    sourcemap: true,
    // Remaining >500 kB chunks are all shiki language packs (cpp, wasm,
    // emacs-lisp, etc) that shiki loads on demand via dynamic import. They
    // are not shipped on first paint. Raise the warning threshold so only
    // actual app bundles trigger it.
    chunkSizeWarningLimit: 800,
  },
});
