import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The kernel and people-intelligence suites, run with EVERY outbound network primitive
 * replaced by one that throws (tests/helpers/no-outbound-network.setup.ts).
 *
 * R0–R3 forbid contacting any hosted service, live model or messaging API. Asserting that
 * about code you wrote is easy; asserting it about everything you imported is not. Passing
 * under this config is the proof.
 *
 *   npx vitest run -c vitest.no-network.config.ts
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/kernel/**/*.test.ts"],
    setupFiles: ["tests/helpers/no-outbound-network.setup.ts"],
    reporters: "default",
  },
});
