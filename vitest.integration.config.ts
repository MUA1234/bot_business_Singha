import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration test config: live DB tests (tests/integration). They open real Postgres
 * connections and hold a transaction per file, so they run SERIALLY (no file
 * parallelism) with a generous timeout to avoid connection contention against a hosted
 * Supabase instance. Unit tests use the default `vitest.config.ts`.
 */
export default defineConfig({
  // The rendered-vs-persisted check (R1 §7 path 9) renders real components against rows read from
  // the database, so this config needs JSX just as the unit one does. tsconfig has
  // `"jsx": "preserve"` for Next, which leaves esbuild on the classic runtime and no React import.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts", "tests/integration/**/*.test.tsx"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false, // serialize files — one DB connection at a time
    reporters: "default",
  },
});
