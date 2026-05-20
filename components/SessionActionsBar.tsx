"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen, Download, Loader2, RotateCcw, Trash2 } from "lucide-react";
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
import { RetranscribeDialog } from "@/components/RetranscribeDialog";

export interface SessionActionsBarProps {
  sessionId: string;
  audioUrl: string | null;
  title: string;
}

/**
 * Pluck the audio file extension off the storage URL (e.g.
 * /api/audio/file/audio/<cuid>/final.webm → ".webm"). Returns a
 * leading dot so callers can concatenate. Falls back to ".webm"
 * because that's what MediaRecorder produces in every browser we
 * support — better to guess one specific codec than to write a
 * generic ".audio" the OS can't recognize.
 */
function audioExtensionFromUrl(url: string): string {
  try {
    const path = url.split("?")[0];
    const last = path.split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    if (dot > 0 && dot < last.length - 1) {
      const ext = last.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{2,5}$/.test(ext)) return `.${ext}`;
    }
  } catch {
    /* fall through */
  }
  return ".webm";
}

export function SessionActionsBar({
  sessionId,
  audioUrl,
  title,
}: SessionActionsBarProps) {
  const router = useRouter();
  const [retranscribeOpen, setRetranscribeOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const resp = await fetch(`/api/transcription/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (!resp.ok && resp.status !== 204) {
        toast.error(`删除失败 (${resp.status})`);
        return;
      }
      toast.success("已删除");
      router.push("/dashboard/history");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setRetranscribeOpen(true)}
      >
        <RotateCcw className="h-4 w-4" />
        <span>重新转录</span>
      </Button>

      <Button variant="outline" size="sm" asChild>
        <Link href="/dashboard/vocabulary">
          <BookOpen className="h-4 w-4" />
          <span>词汇本</span>
        </Link>
      </Button>

      {audioUrl ? (
        <Button variant="outline" size="sm" asChild>
          {/* Derive the file extension from the URL (the storage layer
              names files audio/{sessionId}/final.{webm|m4a|ogg}). The
              previous ".audio" suffix made browsers save files with an
              unrecognized extension that no media player could open. */}
          <a
            href={audioUrl}
            download={`${title || "recording"}${audioExtensionFromUrl(audioUrl)}`}
          >
            <Download className="h-4 w-4" />
            <span>下载音频</span>
          </a>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          <Download className="h-4 w-4" />
          <span>下载音频</span>
        </Button>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => setDeleteOpen(true)}
        className="text-rose-600 hover:text-rose-700"
      >
        <Trash2 className="h-4 w-4" />
        <span>删除</span>
      </Button>

      <RetranscribeDialog
        sessionId={sessionId}
        open={retranscribeOpen}
        onOpenChange={setRetranscribeOpen}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除录音</DialogTitle>
            <DialogDescription>
              确认删除「{title || "未命名录音"}」？此操作不可撤销，转录、纪要、书签会一并清除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span>确认删除</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default SessionActionsBar;
