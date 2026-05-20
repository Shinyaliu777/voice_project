"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { Recorder } from "@/components/Recorder";
import { getAudioLocalCache } from "@/lib/audio/local-cache";
import { cn } from "@/lib/utils";

interface RecorderLaneProps {
  /** All optional — Recorder.tsx has its own internal defaults (en / zh)
   *  and a blank title. RecorderLane prefers values from
   *  /api/user/settings (defaultSourceLang / defaultTargetLang under
   *  the 通用 tab in SettingsDialog) so users who routinely record in
   *  a non-default language don't have to set it every time. Falls
   *  back to props (currently unused) then to Recorder's internal
   *  en/zh defaults. */
  defaultSourceLang?: string;
  defaultTargetLang?: string;
  defaultTitle?: string;
}

const LANG_CACHE_KEY = "voice-project:lastLangPair";

/**
 * Keeps the Recorder mounted at the layout level so audio capture,
 * Soniox WebSocket, and the live-translate debouncer all keep running
 * even when the user navigates to /dashboard/chat, /dashboard/history,
 * /dashboard/vocabulary, etc.
 *
 * Why: the Recorder used to live in app/(app)/dashboard/page.tsx and
 * would unmount the instant the user clicked any sidebar link, which
 * destroyed the AudioContext + WS and silently terminated the recording.
 * Users reported "切到对话页就退出录音了，无法再继续". Stopping a
 * recording must be an explicit user action ("结束录制"); accidental
 * navigation should not have that effect.
 *
 * How: this client wrapper is rendered once in the (app)/layout.tsx
 * shell. It mounts <Recorder /> unconditionally so React keeps the
 * instance alive across client-side route transitions. When the user
 * is NOT on the /dashboard landing route we hide the UI with `hidden`
 * (display: none) — that does NOT unmount the React subtree, so the
 * AudioContext, the WS, and all the per-utterance state survive. The
 * user navigates into a chat page, the recorder keeps going; they
 * navigate back, the UI reappears exactly where they left it.
 *
 * Browser-level tab visibility is handled separately inside
 * lib/audio/recorder.ts (visibilitychange + AudioContext statechange
 * resume) — that path is for switching to a different browser tab.
 * This path is for in-tab client navigation.
 */
export function RecorderLane({
  defaultSourceLang: propSrc,
  defaultTargetLang: propTgt,
  defaultTitle,
}: RecorderLaneProps) {
  const pathname = usePathname();
  // Recorder UI is the /dashboard landing page. Any other dashboard
  // sub-route hides it but keeps the React subtree mounted.
  const visible = pathname === "/dashboard";

  // Resolve default language pair from the most authoritative source
  // we have. Synchronously read localStorage on first render so the
  // Recorder mounts immediately with the right defaults; then fetch
  // /api/user/settings to refresh the cache for next time. Recorder's
  // own useState locks the initial values, so this avoids the
  // "everyone gets en/zh on first mount" regression that came with
  // dropping the per-navigation prisma lookup.
  const [defaults] = React.useState(() => {
    if (typeof window === "undefined") {
      return { src: propSrc ?? "en", tgt: propTgt ?? "zh" };
    }
    try {
      const cached = window.localStorage.getItem(LANG_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { src?: string; tgt?: string };
        if (parsed.src && parsed.tgt) {
          return { src: parsed.src, tgt: parsed.tgt };
        }
      }
    } catch {
      /* ignore corrupt cache */
    }
    return { src: propSrc ?? "en", tgt: propTgt ?? "zh" };
  });

  // Refresh the localStorage cache from user.settings (single source
  // of truth, written by SettingsDialog). Only affects the NEXT
  // mount — current Recorder keeps its locked defaults.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/user/settings");
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as {
          settings?: { defaultSourceLang?: string; defaultTargetLang?: string };
        };
        const s = data.settings ?? {};
        if (s.defaultSourceLang && s.defaultTargetLang) {
          try {
            window.localStorage.setItem(
              LANG_CACHE_KEY,
              JSON.stringify({
                src: s.defaultSourceLang,
                tgt: s.defaultTargetLang,
              })
            );
          } catch {
            /* ignore quota errors */
          }
        }
      } catch {
        /* ignore — defaults already applied */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Boot-time IndexedDB recovery.
  //
  // If a previous recording exited via tab close or browser crash, the
  // Recorder will have persisted any in-flight chunk to IndexedDB
  // BEFORE attempting the network upload (lib/audio/recorder.ts
  // ondataavailable handler). The pagehide sendBeacon is a best-effort
  // fast path; this loop is the durable backup.
  //
  // For every chunk that wasn't marked uploaded, replay it through the
  // single-shot POST /api/audio/upload-chunk (same path sendBeacon
  // uses), then flip uploaded=true on success. Failed retries stay in
  // IndexedDB for the next session. cleanupOldChunks GC's rows that
  // succeeded long ago.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const cache = getAudioLocalCache();
      // Sweep uploaded+old rows first so the pending list is small.
      void cache.cleanupOldChunks().catch(() => {});

      let pending: Awaited<ReturnType<typeof cache.getAllPendingChunks>>;
      try {
        pending = await cache.getAllPendingChunks();
      } catch {
        return;
      }
      if (cancelled || pending.length === 0) return;

      for (const row of pending) {
        if (cancelled) return;
        try {
          const fd = new FormData();
          fd.append("sessionId", row.sessionId);
          fd.append("chunkIndex", String(row.chunkIndex));
          fd.append(
            "durationSeconds",
            String((row.durationMs ?? 0) / 1000)
          );
          fd.append("contentType", row.contentType);
          fd.append("file", row.blob, `chunk-${row.chunkIndex}.webm`);
          const resp = await fetch("/api/audio/upload-chunk", {
            method: "POST",
            body: fd,
          });
          if (resp.ok) {
            await cache
              .markUploaded(row.sessionId, row.chunkIndex)
              .catch(() => {});
          }
        } catch {
          // Network unavailable, server 500, etc. Keep the row for
          // the next mount; better to retry than to lose audio.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className={cn(
        "h-full",
        visible ? "block" : "hidden"
      )}
      aria-hidden={!visible}
    >
      <div className="mx-auto flex h-[calc(100vh-3rem)] max-w-3xl flex-col px-3 py-4 sm:max-w-4xl sm:px-4 sm:py-6 md:max-w-5xl md:px-6 lg:px-8">
        <Recorder
          defaultSourceLang={defaults.src}
          defaultTargetLang={defaults.tgt}
          defaultTitle={defaultTitle}
        />
      </div>
    </div>
  );
}

export default RecorderLane;
