/**
 * Custom Next.js HTTP server.
 *
 * Why this exists: we need a WebSocket endpoint at `/ws/live/:token` for the
 * live-share bidirectional channel (see `lib/live-share/ws-server.ts`). The
 * App Router can't host long-lived WS connections, so we boot Node's HTTP
 * server ourselves, hand normal requests to Next's request handler, and
 * intercept upgrade requests for WS.
 *
 * Caveats
 * -------
 * - Custom server is incompatible with Turbopack as of Next 15. We run
 *   `next dev` (webpack) and `next build` (webpack) here. Slower HMR is the
 *   trade-off for owning the upgrade channel.
 * - We launch via `tsx` in both dev and prod (see package.json scripts). No
 *   separate build step for `server.ts` itself — `tsx` runs the .ts file
 *   directly and Next handles its own compiled output.
 */

import http from "node:http";
import next from "next";

import { attachLiveShareWs } from "./lib/live-share/ws-server";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const nextApp = next({ dev, hostname, port });
const handle = nextApp.getRequestHandler();

async function main(): Promise<void> {
  await nextApp.prepare();

  const server = http.createServer((req, res) => {
    // Hand every HTTP request to Next; route resolution, App Router, static
    // assets — all of it lives inside `handle`.
    handle(req, res).catch((err) => {
      console.error("[server] request handler failed:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      } else {
        res.end();
      }
    });
  });

  // Wire up the live-share WebSocket upgrade handler. Anything that isn't a
  // WS upgrade to `/ws/live/:token` is left alone — Next itself has no
  // upgrade handlers today, so unmatched upgrades will simply hang and time
  // out client-side, which is the same behavior as `next start`.
  attachLiveShareWs(server);

  server.listen(port, hostname, () => {
    const proto = "http";
    console.log(
      `[server] ready on ${proto}://${hostname}:${port} (dev=${dev})`
    );
  });

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`[server] received ${signal}, shutting down`);
    server.close(() => {
      process.exit(0);
    });
    // Force-exit after 10s if something pins the event loop.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
