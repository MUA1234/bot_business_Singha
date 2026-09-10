import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { KERNEL_SUITE_GLOBS } from "./tests/integration/campaigns.js";

/**
 * KERNEL integration campaign — the R1/R2 management-kernel suites.
 *
 * These need a database carrying the released migrations AND the quarantined draft chain in
 * `src/db/draft-migrations-r1/`, applied once. They are separated from the core campaign because
 * the two want incompatible databases, not merely different file lists: the core enumeration
 * gates assert every SECURITY DEFINER function in `public` is classified, and the draft functions
 * are deliberately absent from that allowlist.
 *
 * Run: `npm run test:kernel` against a database prepared with shim + migrate + draft-migrate --up,
 * or `node scripts/r1/run-r1-security-tests.mjs`, which provisions that database itself.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: KERNEL_SUITE_GLOBS,
    exclude: ["**/node_modules/**"],
    testTimeout: 30000,
    hookTimeout: 300000, // r1-draft-schema builds its own database: shim + 110 migrations + drafts
    fileParallelism: false,
    // Randomised for the same reason as the core campaign: a suite that passes only because a
    // neighbour left state behind is failing, and a fixed order conceals it.
    sequence: { shuffle: { files: true, tests: false } },
    reporters: "default",
  },
});
