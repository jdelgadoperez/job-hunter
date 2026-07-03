import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is built to `web/dist`, which the Hono server (`job-hunter serve`) serves as
// static assets. In dev, `npm run dev:web` proxies `/api` to a separately-running `serve`.
//
// The proxy target uses `127.0.0.1`, not `localhost`, on purpose: the server binds IPv4 loopback
// only (see the DNS-rebinding guard in src/server), whereas `localhost` resolves to IPv6 `::1`
// first on modern macOS/Node. If anything else holds `*:4317` on IPv6 (e.g. OrbStack's OTLP
// telemetry listener, which defaults to 4317), a `localhost` target lands there instead and Vite's
// HTTP/1.1 proxy fails to parse the reply ("Expected HTTP/, RTSP/ or ICE/"). Pinning IPv4 matches
// the server's actual bind and sidesteps the collision.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
});
