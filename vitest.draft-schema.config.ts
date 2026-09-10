import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { SELF_MANAGED_SUITES } from "./tests/integration/campaigns.js";

/**
 * DRAFT-SCHEMA campaign — the third and smallest of the three.
 *
 * `r1-draft-schema` applies the whole R1 draft chain and then ROLLS IT BACK, because proving the
 * rollback leaves nothing behind is one of the things it exists to prove. That makes it
 * incompatible with any shared database: on the core one it would introduce draft objects the
 * enumeration gates refuse to classify, and on the kernel one its teardown removes the schema its
 * neighbours depend on. It is excluded from both campaign configs and runs here instead.
 *
 * The suite builds and drops its OWN database inside whatever server `DATABASE_URL` points at, so
 * this config needs only a loopback server. `scripts/r1/run-draft-schema-tests.mjs` provides one
 * in a disposable container.
 *
 * Run: `npm run test:draft-schema`, or the runner above, which provisions the container too.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: SELF_MANAGED_SUITES.map((f) => `tests/integration/${f}`),
    exclude: ["**/node_modules/**"],
    testTimeout: 60000,
    // It builds a database from nothing: shim, 110 released migrations, seed rows, 28 draft
    // units. That is the honest cost of not borrowing somebody else's schema.
    hookTimeout: 300000,
    fileParallelism: false,
    reporters: "default",
  },
});
