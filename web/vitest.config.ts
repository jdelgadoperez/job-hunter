import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dashboard unit tests run under jsdom with React Testing Library. They're separate from the
// server/CLI suite (root vitest.config.ts) because they need a DOM environment and the React plugin.
// `root` is pinned to this directory so includes/setupFiles resolve here, not against the repo root
// (which would otherwise sweep in the server/CLI `src/**` tests). All network access is mocked
// (global fetch), so these never touch a real server.
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    root: here,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
