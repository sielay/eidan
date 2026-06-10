import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest configuration for the web app's logical-layer tests.
 *
 * Scope: pure functions and data transformations under `src/lib/`
 * and small extracted helpers from components. No React rendering
 * yet — that's the next step (React Testing Library + happy-path
 * route tests).
 *
 * The `jsdom` environment lets tests touch browser globals
 * (e.g. `Intl.DateTimeFormat`, `window.fetch` mocks) without
 * spinning up a real browser.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist", ".next"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts", "src/components/**/*.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
