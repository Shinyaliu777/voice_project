/**
 * Healthcheck route.
 *
 * Used by Vercel / uptime monitors / load balancers to verify the app and its
 * external dependencies are reachable.
 *
 *   200 { ok: true,  db: "ok",   redis: "ok" | "skipped" }
 *   503 { ok: false, db: "ok"|"down", redis: "ok"|"skipped"|"down" }
 *
 * Redis is treated as optional — without REDIS_URL we just report `"skipped"`
 * and stay green. Once Agent B's ioredis lands, an unreachable Redis flips
 * the response to 503 so monitors notice.
 */
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Status = "ok" | "skipped" | "down";

interface HealthResponse {
  ok: boolean;
  db: Status;
  redis: Status;
}

async function checkDb(): Promise<Status> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "down";
  }
}

async function checkRedis(): Promise<Status> {
  const url = process.env.REDIS_URL;
  if (!url) return "skipped";

  // ioredis is installed by Agent B in parallel. Resolve it through a string
  // expression so TypeScript doesn't try to type-check the import when the
  // package isn't on disk yet; once it lands the runtime require picks it up
  // unchanged. If the module isn't installed, we surface that as "down".
  let RedisCtor: unknown;
  try {
    const moduleName: string = "ioredis";
    const mod = (await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleName).catch(
      () => null
    )) as { default?: unknown } | null;
    RedisCtor = mod?.default ?? mod;
  } catch {
    return "down";
  }
  if (typeof RedisCtor !== "function") return "down";

  type RedisLike = {
    ping: () => Promise<string>;
    quit: () => Promise<unknown>;
    disconnect: () => void;
  };
  const Ctor = RedisCtor as new (url: string, opts: object) => RedisLike;
  let client: RedisLike | null = null;
  try {
    client = new Ctor(url, {
      // Don't queue commands while reconnecting — the healthcheck should fail
      // fast, not buffer.
      enableOfflineQueue: false,
      // One quick attempt; we don't want the request to hang on a flapping
      // Redis instance.
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: false,
    });
    const pong = await client.ping();
    return pong === "PONG" ? "ok" : "down";
  } catch {
    return "down";
  } finally {
    if (client) {
      try {
        await client.quit();
      } catch {
        try {
          client.disconnect();
        } catch {
          /* swallow */
        }
      }
    }
  }
}

export async function GET(): Promise<NextResponse<HealthResponse>> {
  const [db, redis] = await Promise.all([checkDb(), checkRedis()]);
  const ok = db === "ok" && redis !== "down";
  const body: HealthResponse = { ok, db, redis };
  return NextResponse.json(body, { status: ok ? 200 : 503 });
}
