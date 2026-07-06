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
        // Live Postgres (service-role) store for the hosted worker — smoke-only via
        // `npm run smoke:postgres`. The pure row mappers it uses ARE unit-tested.
        "src/backend/postgres-scan-store.ts",
        // Worker entrypoint: real browser + live Postgres, run via `npm run scan:worker`.
        // The orchestration (`runScannerOnce`) IS unit-tested.
        "src/backend/scanner/main.ts",
        // Shells out to git + network for the update check; pure logic lives in version.ts.
        "src/runtime/update-check.ts",
        // Server listener + real scan pipeline: bind a port / launch a browser / hit the
        // network, so smoke-only. The unit-tested logic lives in `server/app.ts`.
        "src/server/serve.ts",
        "src/server/scan-runner.ts",
        // Real LLM deep-score pipeline (live provider calls), smoke-only like scan-runner. The
        // unit-tested logic lives in `server/score-job.ts` + the routes in `server/app.ts`.
        "src/server/score-runner.ts",
        // Shells out to the per-platform `service-*.{sh,ps1}` scripts (spawns a child process). The
        // pure invocation resolver (`resolveServiceInvocation`) IS unit-tested in service.test.ts.
        "src/cli/service.ts",
      ],
      reporter: ["text", "html"],
      // Floor for the gate, a few points below current coverage so honest churn
      // doesn't fail CI but a real regression does. Raise as coverage climbs.
      // Statements floor dropped 93→92 with the Vitest 4 / coverage-v8 4 upgrade:
      // v4's AST-aware statement remapping recounts statements (1486/1601 = 92.81%)
      // vs v3's metric, with no change to tests (all 406 still pass) or source.
      thresholds: {
        statements: 92,
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
