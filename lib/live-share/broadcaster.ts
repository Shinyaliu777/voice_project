/**
 * Pub/sub for live-share viewers.
 *
 * Two endpoints share this module:
 *
 *  - The SSE GET route registers a subscriber per token.
 *  - The host push POST route looks up subscribers and forwards utterance /
 *    segment / control payloads.
 *
 * Two modes are supported, transparently to callers:
 *
 *  1. **Redis mode** — active when `REDIS_URL` is set. One pub + one sub
 *     `ioredis` client per process (singletons, lazily initialized). Pub uses
 *     `PUBLISH live-share:<token>`; sub uses `SUBSCRIBE live-share:<token>` and
 *     fans the incoming message out to every locally-registered listener on
 *     that token. This is required for multi-instance deployments (Vercel
 *     serverless, multi-container Node) where a push hitting instance A must
 *     reach SSE viewers connected to instance B.
 *
 *  2. **In-memory mode** — fallback for local dev when `REDIS_URL` is unset.
 *     A process-local `Map<token, Set<Listener>>` mirrors the original
 *     phase-1 behavior. Single-node only.
 *
 * The public surface (`subscribe`, `broadcast`, `subscriberCount`) is identical
 * across modes — callers don't change.
 */

import type Redis from "ioredis";

type Listener = (payload: object) => void;

const globalKey = "__voice_live_share_subscribers__" as const;
const redisStateKey = "__voice_live_share_redis_state__" as const;

const CHANNEL_PREFIX = "live-share:";

interface InMemoryStore {
  [globalKey]?: Map<string, Set<Listener>>;
}

interface RedisState {
  pub: Redis | null;
  sub: Redis | null;
  // Per-token listeners. The sub client is SUBSCRIBE'd lazily on the first
  // listener for a token, and UNSUBSCRIBE'd when the last one goes away.
  listeners: Map<string, Set<Listener>>;
  messageHandlerAttached: boolean;
}

interface RedisGlobal {
  [redisStateKey]?: RedisState;
}

function inMemoryStore(): Map<string, Set<Listener>> {
  const g = globalThis as unknown as InMemoryStore;
  if (!g[globalKey]) {
    g[globalKey] = new Map<string, Set<Listener>>();
  }
  return g[globalKey]!;
}

function redisEnabled(): boolean {
  return Boolean(process.env.REDIS_URL && process.env.REDIS_URL.length > 0);
}

function redisState(): RedisState {
  const g = globalThis as unknown as RedisGlobal;
  if (!g[redisStateKey]) {
    g[redisStateKey] = {
      pub: null,
      sub: null,
      listeners: new Map<string, Set<Listener>>(),
      messageHandlerAttached: false,
    };
  }
  return g[redisStateKey]!;
}

/**
 * Lazy-init for the pub client. ioredis auto-reconnects on transient network
 * errors; we just log on error/ready and let the client drive recovery.
 */
async function getPub(): Promise<Redis> {
  const state = redisState();
  if (state.pub) return state.pub;
  const { default: IORedis } = await import("ioredis");
  const client = new IORedis(process.env.REDIS_URL!, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  client.on("error", (err: Error) => {
    console.warn("[live-share] redis pub error:", err.message);
  });
  client.on("ready", () => {
    console.info("[live-share] redis pub ready");
  });
  state.pub = client;
  return client;
}

/**
 * Lazy-init for the sub client. ioredis requires a dedicated connection for
 * subscriber mode — commands other than (P)SUB/UNSUB are not allowed on it.
 */
async function getSub(): Promise<Redis> {
  const state = redisState();
  if (state.sub) return state.sub;
  const { default: IORedis } = await import("ioredis");
  const client = new IORedis(process.env.REDIS_URL!, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  client.on("error", (err: Error) => {
    console.warn("[live-share] redis sub error:", err.message);
  });
  client.on("ready", () => {
    console.info("[live-share] redis sub ready");
  });
  if (!state.messageHandlerAttached) {
    client.on("message", (channel: string, message: string) => {
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      const token = channel.slice(CHANNEL_PREFIX.length);
      const bucket = state.listeners.get(token);
      if (!bucket || bucket.size === 0) return;
      let parsed: object;
      try {
        parsed = JSON.parse(message) as object;
      } catch {
        return;
      }
      for (const fn of bucket) {
        try {
          fn(parsed);
        } catch {
          /* ignore individual listener failures */
        }
      }
    });
    state.messageHandlerAttached = true;
  }
  state.sub = client;
  return client;
}

/**
 * Register a listener for a token. Returns an unsubscribe function.
 *
 * Calling the unsubscribe is required when the SSE connection closes; otherwise
 * the listener will pin live segments in memory after the viewer is gone (and,
 * in Redis mode, keep the channel subscription open).
 */
export function subscribe(token: string, fn: Listener): () => void {
  if (redisEnabled()) {
    const state = redisState();
    let bucket = state.listeners.get(token);
    const isFirst = !bucket;
    if (!bucket) {
      bucket = new Set();
      state.listeners.set(token, bucket);
    }
    bucket.add(fn);
    if (isFirst) {
      // Kick off SUBSCRIBE asynchronously. Any messages published before this
      // completes are simply not delivered to this brand-new listener — that
      // window is on the order of one round-trip and matches the prior
      // in-memory semantics (you only get events after you subscribe).
      getSub()
        .then((sub) => sub.subscribe(`${CHANNEL_PREFIX}${token}`))
        .catch((err) => {
          console.warn(
            "[live-share] redis SUBSCRIBE failed:",
            err instanceof Error ? err.message : String(err)
          );
        });
    }
    return () => {
      const b = state.listeners.get(token);
      if (!b) return;
      b.delete(fn);
      if (b.size === 0) {
        state.listeners.delete(token);
        // Last listener gone — release the channel.
        getSub()
          .then((sub) => sub.unsubscribe(`${CHANNEL_PREFIX}${token}`))
          .catch((err) => {
            console.warn(
              "[live-share] redis UNSUBSCRIBE failed:",
              err instanceof Error ? err.message : String(err)
            );
          });
      }
    };
  }

  // In-memory fallback.
  const map = inMemoryStore();
  let bucket = map.get(token);
  if (!bucket) {
    bucket = new Set();
    map.set(token, bucket);
  }
  bucket.add(fn);
  return () => {
    const b = map.get(token);
    if (!b) return;
    b.delete(fn);
    if (b.size === 0) map.delete(token);
  };
}

/**
 * Push a payload to every subscriber on this token. Listener errors are
 * swallowed — one broken viewer must not drop other viewers.
 *
 * In Redis mode this fires `PUBLISH` and returns immediately; the actual
 * fan-out happens on whichever instance(s) hold the SSE listeners.
 */
export function broadcast(token: string, payload: object): void {
  if (redisEnabled()) {
    getPub()
      .then((pub) =>
        pub.publish(`${CHANNEL_PREFIX}${token}`, JSON.stringify(payload))
      )
      .catch((err) => {
        console.warn(
          "[live-share] redis PUBLISH failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
    return;
  }

  // In-memory fallback.
  const bucket = inMemoryStore().get(token);
  if (!bucket || bucket.size === 0) return;
  for (const fn of bucket) {
    try {
      fn(payload);
    } catch {
      /* ignore individual listener failures */
    }
  }
}

/** Test helper — exposed for unit tests but not part of the public surface. */
export function subscriberCount(token: string): number {
  if (redisEnabled()) {
    return redisState().listeners.get(token)?.size ?? 0;
  }
  return inMemoryStore().get(token)?.size ?? 0;
}
