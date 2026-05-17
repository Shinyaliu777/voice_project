/**
 * Smoke test for lib/live-share/broadcaster.
 *
 * Subscribes to token "test", broadcasts a payload, and prints what the
 * listener receives. Works in both modes:
 *
 *   - default: in-memory fallback (no env required)
 *   - REDIS_URL=redis://... npx tsx scripts/test-broadcaster.ts
 *
 * Run:   npx tsx scripts/test-broadcaster.ts
 */

import { broadcast, subscribe } from "../lib/live-share/broadcaster";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const mode = process.env.REDIS_URL ? "redis" : "in-memory";
  console.log(`[test-broadcaster] mode=${mode}`);

  let received: object | null = null;
  const unsubscribe = subscribe("test", (payload) => {
    received = payload;
    console.log("[test-broadcaster] received:", JSON.stringify(payload));
  });

  // Give SUBSCRIBE a moment to take effect on the Redis path (no-op for
  // in-memory).
  await sleep(100);

  broadcast("test", { hello: "world" });

  // Wait for the message to round-trip through Redis (in-memory delivery is
  // synchronous so 200 ms is overkill there, but harmless).
  await sleep(200);

  unsubscribe();

  if (!received) {
    console.error("[test-broadcaster] FAIL: no message received");
    process.exit(1);
  }

  console.log("[test-broadcaster] OK");
  // Force-exit so the ioredis sockets (if any) don't keep the process alive.
  process.exit(0);
}

main().catch((err) => {
  console.error("[test-broadcaster] error:", err);
  process.exit(1);
});
