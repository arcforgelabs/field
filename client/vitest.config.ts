import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const clientRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(clientRoot, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
    // Each jsdom worker holds a few hundred MiB; several agent sessions often
    // run the suite at once on one workstation. FIELD_TEST_CONCURRENCY raises it.
    maxWorkers: Number(process.env.FIELD_TEST_CONCURRENCY) || 4,
  },
});
