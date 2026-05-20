"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

import { Recorder } from "@/components/Recorder";
import { cn } from "@/lib/utils";

interface RecorderLaneProps {
  defaultSourceLang: string;
  defaultTargetLang: string;
  defaultTitle?: string;
}

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
  defaultSourceLang,
  defaultTargetLang,
  defaultTitle,
}: RecorderLaneProps) {
  const pathname = usePathname();
  // Recorder UI is the /dashboard landing page. Any other dashboard
  // sub-route hides it but keeps the React subtree mounted.
  const visible = pathname === "/dashboard";

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
          defaultSourceLang={defaultSourceLang}
          defaultTargetLang={defaultTargetLang}
          defaultTitle={defaultTitle}
        />
      </div>
    </div>
  );
}

export default RecorderLane;
