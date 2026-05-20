/**
 * Tiny analytics client SDK — wraps PostHog's web JS so the rest of the
 * codebase has a single, stable surface to call.
 *
 * Why PostHog (self-hosted) was picked over Mixpanel / Plausible / Umami:
 *   - Mixpanel: SaaS only; api.mixpanel.com is intermittently blocked in CN
 *     and lecsync's own bundle confirms they had to fight that. Doesn't fit
 *     the "voice.cyanclay.org 国内自托管" deployment story.
 *   - Plausible / Umami: web-analytics first — great for pageviews, weak
 *     for the product-funnel questions we actually need ("用户卡哪 / 哪个
 *     功能常用 / 哪个最常失败 / 留存"). No identify() with user traits, no
 *     funnels, no session replay.
 *   - PostHog (self-hosted): single-image deploy on the same Linux box,
 *     ingestion runs from a domain WE control (no GFW dependency), full
 *     product-analytics surface (events / funnels / retention / replay
 *     when needed), and the JS SDK auto-batches + sendBeacons on pagehide
 *     so beta-traffic doesn't lose events.
 *
 * Backend wire-up: set
 *   NEXT_PUBLIC_POSTHOG_KEY="<project key>"
 *   NEXT_PUBLIC_POSTHOG_HOST="https://ph.cyanclay.org"  // your reverse-proxied host
 * in .env. When the key is missing (e.g. local dev without a PostHog
 * instance) every call below is a no-op — never throws, never blocks.
 *
 * Privacy: we deliberately do NOT pass PII through track props. Callers
 * must NOT pass email / 转录文本 / minutes 内容 / user-typed strings.
 * If you add a new event, only ship ids, enums, durations, counts, codes.
 */

type PostHogClient = {
  init: (key: string, opts: Record<string, unknown>) => void;
  capture: (event: string, props?: Record<string, unknown>) => void;
  identify: (id: string, traits?: Record<string, unknown>) => void;
  reset: () => void;
  __loaded?: boolean;
};

declare global {
  interface Window {
    posthog?: PostHogClient;
  }
}

const KEY =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_POSTHOG_KEY
    : undefined;
const HOST =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_POSTHOG_HOST
    : undefined;

let initStarted = false;
let initDone = false;
/** Buffer events that fire before the JS bundle finishes loading. */
const queue: Array<() => void> = [];

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function enabled(): boolean {
  return isBrowser() && typeof KEY === "string" && KEY.length > 0;
}

/**
 * Lazy-load posthog-js from CDN and call init() once. Calling this from
 * track() / identify() before posthog has loaded just queues the call —
 * once load resolves we drain the queue.
 *
 * We could `npm install posthog-js` instead. The CDN script keeps the
 * Next bundle small (~80KB saved) and lets us version-bump from env
 * without redeploying. Both work.
 */
function ensureLoaded(): void {
  if (!enabled()) return;
  if (initStarted) return;
  initStarted = true;

  try {
    const existing = window.posthog;
    if (existing && existing.__loaded) {
      initDone = true;
      drain();
      return;
    }

    // Loader stub borrowed from posthog-js docs — keeps a queue of calls
    // until the real bundle replaces window.posthog.
    const script = document.createElement("script");
    script.src = `${HOST ?? "https://us.i.posthog.com"}/static/array.js`;
    script.async = true;
    script.onload = () => {
      try {
        const ph = window.posthog;
        if (!ph) return;
        ph.init(KEY as string, {
          api_host: HOST ?? "https://us.i.posthog.com",
          // 内测阶段不开 session replay — 录音页隐私敏感且流量浪费
          disable_session_recording: true,
          autocapture: false,
          capture_pageview: true,
          capture_pageleave: true,
          persistence: "localStorage+cookie",
          loaded: () => {
            initDone = true;
            drain();
          },
        });
      } catch {
        /* swallow — analytics MUST NOT break the app */
      }
    };
    script.onerror = () => {
      // CDN blocked / offline. Clear the queue so we don't leak memory
      // accumulating events nobody will ever read.
      queue.length = 0;
    };
    document.head.appendChild(script);
  } catch {
    /* swallow */
  }
}

function drain(): void {
  while (queue.length) {
    const fn = queue.shift();
    if (!fn) continue;
    try {
      fn();
    } catch {
      /* swallow */
    }
  }
}

function runOrQueue(fn: () => void): void {
  if (!enabled()) return;
  ensureLoaded();
  if (initDone && window.posthog) {
    try {
      fn();
    } catch {
      /* swallow */
    }
    return;
  }
  // Avoid unbounded growth in pathological "PostHog never loads" cases.
  if (queue.length < 200) queue.push(fn);
}

/**
 * Fire a product event.
 *
 * @param eventName  snake_case event name from docs/analytics-events.md.
 * @param props      Optional metadata. NEVER pass PII (email / 转录文本 /
 *                   minutes 内容 / user-typed strings). Stick to ids,
 *                   enums, durations, counts, status codes, language tags.
 */
export function track(
  eventName: string,
  props?: Record<string, unknown>
): void {
  runOrQueue(() => {
    window.posthog?.capture(eventName, props);
  });
}

/**
 * Associate the current browser with a user id. Call once after sign-in /
 * app boot when we know who the user is. Safe to call repeatedly — PostHog
 * dedupes by id.
 *
 * @param userId  Stable internal user id. Never email.
 * @param traits  Optional non-PII traits (plan, signup_source, locale).
 */
export function identify(
  userId: string,
  traits?: Record<string, unknown>
): void {
  if (!userId) return;
  runOrQueue(() => {
    window.posthog?.identify(userId, traits);
  });
}

/**
 * Forget the current user (sign-out / account switch). Generates a new
 * anonymous id so subsequent events don't get attributed to the old user.
 */
export function reset(): void {
  runOrQueue(() => {
    window.posthog?.reset();
  });
}
