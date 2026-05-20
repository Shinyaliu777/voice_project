"use client";

import * as React from "react";

import { identify } from "@/lib/analytics";

/**
 * Server-rendered shell passes the resolved user.id down to this client
 * island so we can call `identify()` exactly once on first mount. Nothing
 * else here — PostHog's own JS handles pageview auto-capture, and individual
 * features call `track()` directly.
 *
 * Deliberately does NOT pass email / name / any PII as a trait. Just the
 * opaque user id so events get keyed to the right person.
 */
export function AnalyticsBoot({ userId }: { userId: string }) {
  const onceRef = React.useRef(false);
  React.useEffect(() => {
    if (onceRef.current) return;
    if (!userId) return;
    onceRef.current = true;
    identify(userId);
  }, [userId]);
  return null;
}

export default AnalyticsBoot;
