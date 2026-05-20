"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mic, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface InProgressSession {
  id: string;
  title: string;
  createdAt: string;
  status: string;
  sourceLang: string;
  targetLang: string;
  chunkCount: number;
  segmentCount: number;
  lastChunkEndMs: number;
}

export interface ResumeRecordingBannerProps {
  /** Called when the user picks "继续录制" — Recorder should restart
   *  recording reusing this sessionId (chunk index + segment index
   *  continue from where they left off, server-side). */
  onResume: (session: InProgressSession) => void;
}

/**
 * Banner shown on the dashboard landing when the previous recording
 * session was left in-progress — closed tab without 结束录制, browser
 * crash, network blip during finalize, etc. Offers three actions:
 *
 *   - 继续录制: Recorder restarts with the existing sessionId so new
 *     audio chunks and transcripts append to the previous session.
 *     Soniox doesn't support WS resume, so audio capture really does
 *     start a fresh WS — but everything else (sessionId, chunkIndex
 *     continuation, segmentIndex continuation) glues the two halves
 *     into one logical recording.
 *   - 完成上传: short-circuit to finalize. Concatenates the existing
 *     chunks and marks the session ready, no new audio recorded.
 *     Useful when the user just wants to save what they already had.
 *   - 丢弃: DELETE the session. Chunks cascade. User confirmed in a
 *     second dialog.
 *
 * Self-fetches on mount and self-hides if no recoverable session.
 */
export function ResumeRecordingBanner({ onResume }: ResumeRecordingBannerProps) {
  const router = useRouter();
  const [session, setSession] = React.useState<InProgressSession | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "resume" | "finalize" | "discard">(
    null
  );
  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/transcription/sessions/in-progress");
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as { session: InProgressSession | null };
        if (cancelled) return;
        setSession(data.session);
      } catch {
        /* ignore — banner just won't show */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded || !session || dismissed) return null;

  const minutes = Math.floor(session.lastChunkEndMs / 60_000);
  const seconds = Math.floor((session.lastChunkEndMs % 60_000) / 1000);
  const durationLabel =
    minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;

  const handleResume = () => {
    setBusy("resume");
    onResume(session);
    // Don't reset busy — onResume handler will unmount the banner once
    // Recorder takes over. Leaving spinner showing is the right UX.
  };

  const handleFinalize = async () => {
    setBusy("finalize");
    try {
      const resp = await fetch("/api/audio/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id }),
      });
      if (!resp.ok) {
        const detail = (await resp.json().catch(() => null)) as
          | { error?: string }
          | null;
        toast.error(detail?.error ?? `完成上传失败 (${resp.status})`);
        return;
      }
      toast.success("音频已拼接完成，可在历史记录中回放");
      setDismissed(true);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "完成上传失败");
    } finally {
      setBusy(null);
    }
  };

  const handleDiscard = async () => {
    setBusy("discard");
    try {
      const resp = await fetch(
        `/api/transcription/sessions/${encodeURIComponent(session.id)}`,
        { method: "DELETE" }
      );
      if (!resp.ok) {
        toast.error(`丢弃失败 (${resp.status})`);
        return;
      }
      toast.success("已丢弃");
      setDismissed(true);
      setConfirmDiscardOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "丢弃失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div
        className={cn(
          "mb-4 rounded-[10px] border border-amber-300 bg-amber-50/70 p-4",
          "dark:border-amber-700/60 dark:bg-amber-950/30"
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              上次录音未结束
            </div>
            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              已录 {durationLabel} · {session.chunkCount} 个音频块 ·{" "}
              {session.segmentCount} 句转录 ·{" "}
              {session.sourceLang.toUpperCase()} →{" "}
              {session.targetLang.toUpperCase()}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleResume}
              disabled={busy !== null}
            >
              {busy === "resume" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
              <span>继续录制</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleFinalize}
              disabled={busy !== null}
            >
              {busy === "finalize" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              <span>完成上传</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDiscardOpen(true)}
              disabled={busy !== null}
              className="text-zinc-600 hover:text-rose-600 dark:text-zinc-300 dark:hover:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
              <span>丢弃</span>
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>丢弃这次录音？</DialogTitle>
            <DialogDescription>
              已上传的 {session.chunkCount} 个音频块和 {session.segmentCount}{" "}
              句转录将被永久删除，无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDiscardOpen(false)}
              disabled={busy === "discard"}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDiscard}
              disabled={busy === "discard"}
            >
              {busy === "discard" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              <span>确认丢弃</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ResumeRecordingBanner;
