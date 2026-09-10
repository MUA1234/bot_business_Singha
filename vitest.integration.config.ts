import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { KERNEL_SUITE_GLOBS, SELF_MANAGED_SUITES } from "./tests/integration/campaigns.js";

/**
 * CORE integration campaign — live DB tests that need ONLY the released numbered migrations.
 *
 * Why this config no longer runs everything under `tests/integration/`. It used to, and CI still
 * called it after `shim + npm run migrate` alone — which meant it swept in 35 kernel suites whose
 * tables live in `src/db/draft-migrations-r1/`, deliberately quarantined OUTSIDE the numbered
 * sequence under owner decision R1-D-1. Those suites failed on missing relations, every run, and
 * CI's integration job could not be green as configured.
 *
 * The two campaigns also want different databases, not just different file lists:
 *
 *   * core  — released migrations only, and no draft object anywhere. That is what production
 *             will look like, and it is what the enumeration gates (`secure-definer-grants`,
 *             `search-path-safety`, `rls-coverage`) are written against: they assert that EVERY
 *             SECURITY DEFINER function is classified, so a draft function they correctly refuse
 *             to classify makes them fail.
 *   * kernel — released migrations PLUS the draft chain, applied once.
 *
 * Run: `npm run test:integration` (core) and `npm run test:kernel` (kernel).
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
    // The kernel suites belong to the other campaign, which builds a database they can run on.
    exclude: [
      "**/node_modules/**",
      ...KERNEL_SUITE_GLOBS,
      ...SELF_MANAGED_SUITES.map((f) => `tests/integration/${f}`),
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false, // serialize files — one DB connection at a time
    // Order is deliberately randomised. A suite that only passes because an earlier one left an
    // object behind is failing, and a fixed order hides exactly that. `sequence.seed` is printed
    // on failure, so a bad order is reproducible.
    sequence: { shuffle: { files: true, tests: false } },
    reporters: "default",
  },
});
