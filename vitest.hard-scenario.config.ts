import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Hard-scenario campaign config.
 *
 * These suites drive the LIVE local stack (GoTrue + PostgREST + Postgres + the running
 * application), so they run serially: several scenarios deliberately create contention
 * and a parallel runner would make the outcome depend on scheduling rather than on the
 * behaviour under test.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/hard-scenario/**/*.test.{ts,tsx}"],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    reporters: "default",
  },
});
