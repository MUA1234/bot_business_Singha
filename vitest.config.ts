import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Live DB tests run via `npm run test:integration` (their own serial config).
    exclude: ["**/node_modules/**", "tests/integration/**"],
    reporters: "default",
  },
});
