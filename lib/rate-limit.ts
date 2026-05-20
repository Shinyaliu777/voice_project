/**
 * Tiny in-memory rate limiter for closed-beta scale. Single-process
 * only — adequate for our self-hosted single-node deploy. When we
 * scale to multiple Next.js instances behind nginx, swap the Map for
 * Redis INCR + EXPIRE.
 *
 * Rolling-window counter, not token-bucket: each call cleans expired
 * entries before checking. Good enough at low QPS, simple to reason
 * about.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
// Conservative cap so a misbehaving caller can't OOM us — entries
// expire on access too.
const MAX_KEYS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Check + record a hit against the rolling window.
 *
 * @param key      caller identifier (typically IP, or IP+route)
 * @param limit    max hits allowed in the window
 * @param windowMs window size in ms
 */
export function rateLimitHit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  // Soft cap: if we're at the ceiling, evict a random bucket. This is
  // fine for closed beta — at prod scale we'd want LRU + Redis.
  if (buckets.size >= MAX_KEYS) {
    const first = buckets.keys().next();
    if (!first.done) buckets.delete(first.value);
  }

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    return { allowed: false, retryAfterMs: oldest + windowMs - now };
  }
  bucket.hits.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Extract the client IP from a NextRequest. Trusts X-Forwarded-For
 * because we deploy behind nginx; the first hop is the real client.
 * Falls back to "unknown" so the limit still applies (across all
 * unknown-IP traffic, but that's fine for our threat model).
 */
export function clientIpFromHeaders(
  headers: Headers,
  fallback = "unknown"
): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0].trim() || fallback;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return fallback;
}
