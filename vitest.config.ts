import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // React components are compiled with the AUTOMATIC JSX runtime here. Next.js sets
  // `"jsx": "preserve"` in tsconfig, which leaves esbuild defaulting to the classic
  // `React.createElement` transform and makes any component render throw "React is not defined".
  // Rendering components is how the UI truthfulness claims are checked without a browser.
  esbuild: { jsx: "automatic" },
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
