import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is built to `web/dist`, which the Hono server (`job-hunter serve`) serves as
// static assets. In dev, `npm run dev:web` proxies `/api` to a separately-running `serve`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:4317",
    },
  },
});
