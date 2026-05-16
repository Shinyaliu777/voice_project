/**
 * In-memory pub/sub for live-share viewers.
 *
 * Two endpoints share this module:
 *
 *  - The SSE GET route registers a subscriber per token.
 *  - The host push POST route looks up subscribers and forwards utterance /
 *    segment / control payloads.
 *
 * The state is intentionally process-local. In a multi-process deployment this
 * would need to be replaced with Redis pub/sub or similar. Phase-1 single-node
 * dev is fine.
 */

type Listener = (payload: object) => void;

const globalKey = "__voice_live_share_subscribers__" as const;

interface GlobalStore {
  [globalKey]?: Map<string, Set<Listener>>;
}

function store(): Map<string, Set<Listener>> {
  const g = globalThis as unknown as GlobalStore;
  if (!g[globalKey]) {
    g[globalKey] = new Map<string, Set<Listener>>();
  }
  return g[globalKey]!;
}

/**
 * Register a listener for a token. Returns an unsubscribe function.
 *
 * Calling the unsubscribe is required when the SSE connection closes; otherwise
 * the listener will pin live segments in memory after the viewer is gone.
 */
export function subscribe(token: string, fn: Listener): () => void {
  const map = store();
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
 */
export function broadcast(token: string, payload: object): void {
  const bucket = store().get(token);
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
  return store().get(token)?.size ?? 0;
}
