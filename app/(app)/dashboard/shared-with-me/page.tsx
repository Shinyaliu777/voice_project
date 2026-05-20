"use client";

import * as React from "react";
import Link from "next/link";
import { Inbox, Loader2, Send, Share2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/ShareDialog";
import type { SessionDTO } from "@/lib/contracts";

interface SessionsListResponse {
  items?: SessionDTO[];
}

export default function SharedWithMePage() {
  const [latestSession, setLatestSession] = React.useState<SessionDTO | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [shareOpen, setShareOpen] = React.useState(false);

  // Look up one of the user's existing sessions so the "学习如何分享" link can
  // open a real ShareDialog. If none exists, fall back to /dashboard.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/transcription/sessions?limit=1", {
          cache: "no-store",
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as SessionsListResponse | SessionDTO[];
        const items = Array.isArray(data) ? data : data.items ?? [];
        if (!cancelled && items.length > 0) setLatestSession(items[0]);
      } catch {
        /* swallow — empty state is acceptable */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onLearnClick = () => {
    if (latestSession) setShareOpen(true);
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-full flex-col items-center justify-center px-3 py-10 text-center sm:max-w-3xl sm:px-4 md:px-6 md:py-12 lg:px-8">
      {/* Illustration block — three stacked share icons with a soft halo */}
      <div className="relative mb-8">
        <div className="absolute inset-0 -z-10 m-auto h-32 w-32 rounded-full bg-zinc-200/60 blur-2xl dark:bg-zinc-700/40" />
        <div className="relative flex h-24 w-24 items-center justify-center rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <Share2
            className="h-12 w-12 text-zinc-400 dark:text-zinc-500"
            strokeWidth={1.25}
          />
          <span className="absolute -right-2 -top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            <Inbox className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>

      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        与我分享
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
        当有人把会议、纪要或词汇本分享给你时，会出现在这里。
        <br />
        你也可以把自己的录音邀请别人查看或协作。
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {loading ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>正在加载…</span>
          </Button>
        ) : latestSession ? (
          <Button variant="outline" size="sm" onClick={onLearnClick}>
            <Sparkles className="h-4 w-4" />
            <span>学习如何分享</span>
          </Button>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard">
              <Sparkles className="h-4 w-4" />
              <span>学习如何分享</span>
            </Link>
          </Button>
        )}
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/history">
            <Send className="h-4 w-4" />
            <span>去文件夹看看我的录音</span>
          </Link>
        </Button>
      </div>

      {/* The dialog is mounted lazily only when we have a real session to attach. */}
      {latestSession ? (
        <ShareDialog
          sessionId={latestSession.id}
          title={latestSession.title}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : null}
    </div>
  );
}
