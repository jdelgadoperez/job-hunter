import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Type-only modules have no executable lines.
        "src/**/types.ts",
        // Integration-bound edges (real browser + live network). These have no unit
        // tests by design — they're exercised only by the opt-in `npm run smoke:*`
        // scripts, like `HttpFetcher`. Instrumenting them would skew the gate.
        "src/net/playwright-renderer.ts",
        "src/discovery/sources/airtable-playwright.ts",
      ],
      reporter: ["text", "html"],
      // Floor for the gate, a few points below current coverage so honest churn
      // doesn't fail CI but a real regression does. Raise as coverage climbs.
      thresholds: {
        statements: 93,
        branches: 85,
        functions: 90,
        lines: 93,
      },
    },
  },
  resolve: {
    alias: {
      "@app": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
