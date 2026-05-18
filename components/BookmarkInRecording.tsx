"use client";

import * as React from "react";
import { Bookmark, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { BookmarkDTO, CreateBookmarkBody } from "@/lib/contracts";

export interface BookmarkInRecordingProps {
  sessionId: string;
  /** Returns the elapsed-ms since recording started. */
  getCurrentMs: () => number;
  /** Called after a bookmark is successfully created. */
  onCreated?: (bookmark: BookmarkDTO) => void;
  /** Disable the button (e.g., when not yet recording). */
  disabled?: boolean;
  className?: string;
}

/**
 * "📌 打书签" button. Click drops a bookmark at the current elapsed-ms.
 * Opens a small popover so the user can add an optional note before saving.
 */
export function BookmarkInRecording({
  sessionId,
  getCurrentMs,
  onCreated,
  disabled,
  className,
}: BookmarkInRecordingProps) {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const capturedMsRef = React.useRef(0);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (next) {
        // Snapshot the time at the moment the popover opens.
        capturedMsRef.current = Math.max(0, Math.floor(getCurrentMs()));
        setNote("");
      }
      setOpen(next);
    },
    [getCurrentMs]
  );

  const save = React.useCallback(async () => {
    if (!sessionId) return;
    setSubmitting(true);
    const atMs = capturedMsRef.current;
    const body: CreateBookmarkBody = {
      sessionId,
      atMs,
      note: note.trim() ? note.trim() : undefined,
    };
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        throw new Error(`书签创建失败 (${res.status})`);
      }
      const created = (await res.json()) as BookmarkDTO;
      toast.success("已添加书签");
      onCreated?.(created);
      setOpen(false);
      setNote("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "书签创建失败";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [note, onCreated, sessionId]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={className}
        >
          <Bookmark className="h-4 w-4" />
          <span>打书签</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">添加书签</p>
            <span className="font-mono text-xs text-zinc-500">
              {formatElapsed(capturedMsRef.current)}
            </span>
          </div>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注（可选）…"
            rows={3}
            disabled={submitting}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={save}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Bookmark className="h-4 w-4" />
              )}
              <span>保存</span>
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export default BookmarkInRecording;
