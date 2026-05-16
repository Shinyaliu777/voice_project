"use client";

import * as React from "react";
import { Bookmark, Copy, MoreHorizontal, Pencil, Trash2, UserCog } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { SegmentDTO } from "@/lib/contracts";

const SPEAKER_COLORS = [
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-orange-500",
  "bg-cyan-500",
] as const;

function speakerSwatch(speakerId: number | null | undefined): string {
  if (speakerId == null) return "bg-zinc-400";
  return SPEAKER_COLORS[Math.abs(speakerId) % SPEAKER_COLORS.length];
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export interface SegmentCardProps {
  segment: SegmentDTO;
  speakerName?: string;
  onSeek?: (atMs: number) => void;
  /** Called after an edit succeeds */
  onChanged?: (updated: Partial<SegmentDTO>) => void;
  /** Called after a delete */
  onDeleted?: () => void;
}

export function SegmentCard({
  segment,
  speakerName,
  onSeek,
  onChanged,
  onDeleted,
}: SegmentCardProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(segment.sourceText);
  const [renameSpeaker, setRenameSpeaker] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState("");

  const speakerLabel =
    speakerName ?? (segment.speakerId != null ? `Speaker ${segment.speakerId}` : "Speaker");

  const apiCall = React.useCallback(
    async (path: string, init: RequestInit, successMsg?: string) => {
      try {
        const resp = await fetch(path, {
          ...init,
          headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        if (successMsg) toast.success(successMsg);
        return resp;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Request failed";
        toast.error(msg);
        throw err;
      }
    },
    []
  );

  const copyToClipboard = React.useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(`${label}已复制`);
      } catch {
        toast.error("复制失败");
      }
    },
    []
  );

  const saveEdit = async () => {
    if (draft === segment.sourceText) {
      setEditing(false);
      return;
    }
    try {
      await apiCall(
        `/api/segments/${segment.id}`,
        { method: "PATCH", body: JSON.stringify({ sourceText: draft }) },
        "已保存"
      );
      onChanged?.({ sourceText: draft });
    } catch {
      /* toast already shown */
    } finally {
      setEditing(false);
    }
  };

  const setSpeaker = async (speakerId: number) => {
    try {
      await apiCall(
        `/api/segments/${segment.id}`,
        { method: "PATCH", body: JSON.stringify({ speakerId }) },
        "说话人已更新"
      );
      onChanged?.({ speakerId });
    } catch {
      /* ignored */
    }
  };

  const saveCustomSpeaker = async () => {
    if (!renameDraft.trim()) {
      setRenameSpeaker(false);
      return;
    }
    if (segment.speakerId == null) {
      setRenameSpeaker(false);
      return;
    }
    try {
      await apiCall(
        `/api/sessions/${segment.sessionId}/speakers`,
        {
          method: "POST",
          body: JSON.stringify({ speakerId: segment.speakerId, name: renameDraft.trim() }),
        },
        "已命名说话人"
      );
    } catch {
      /* ignored */
    } finally {
      setRenameSpeaker(false);
      setRenameDraft("");
    }
  };

  const addBookmark = async () => {
    try {
      await apiCall(
        `/api/bookmarks`,
        {
          method: "POST",
          body: JSON.stringify({ sessionId: segment.sessionId, atMs: segment.audioStartMs }),
        },
        "已加入书签"
      );
    } catch {
      /* ignored */
    }
  };

  const deleteSegment = async () => {
    try {
      await apiCall(`/api/segments/${segment.id}`, { method: "DELETE" }, "已删除");
      onDeleted?.();
    } catch {
      /* ignored */
    }
  };

  return (
    <div
      className={cn(
        "group relative rounded-[10px] border border-zinc-100 bg-white p-4",
        "dark:border-zinc-900 dark:bg-zinc-950"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span
              className={cn(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                speakerSwatch(segment.speakerId)
              )}
              aria-hidden
            />
            <span className="font-medium text-zinc-700 dark:text-zinc-200">
              {speakerLabel}
            </span>
            <button
              type="button"
              onClick={() => onSeek?.(segment.audioStartMs)}
              className="rounded px-1 font-mono tabular-nums text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {formatMs(segment.audioStartMs)}
            </button>
            {!segment.isFinal ? (
              <span className="text-amber-600 dark:text-amber-400">（未完成）</span>
            ) : null}
          </div>

          {editing ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                className="text-base"
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(segment.sourceText);
                    setEditing(false);
                  }}
                >
                  取消
                </Button>
                <Button size="sm" onClick={saveEdit}>
                  保存
                </Button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-base leading-relaxed text-zinc-900 dark:text-zinc-100">
              {segment.sourceText}
            </p>
          )}

          {segment.translatedText ? (
            <p className="mt-1.5 whitespace-pre-wrap text-sm italic leading-relaxed text-zinc-500 dark:text-zinc-400">
              {segment.translatedText}
            </p>
          ) : null}

          {renameSpeaker ? (
            <div className="mt-2 flex gap-2">
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                placeholder="说话人名称"
                className="flex h-8 flex-1 rounded-[10px] border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              />
              <Button size="sm" onClick={saveCustomSpeaker}>
                保存
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenameSpeaker(false);
                  setRenameDraft("");
                }}
              >
                取消
              </Button>
            </div>
          ) : null}
        </div>

        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="更多">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil className="h-4 w-4" />
                <span>编辑文字</span>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <UserCog className="h-4 w-4" />
                  <span>改说话人</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {Array.from({ length: 8 }, (_, i) => i + 1).map((sid) => (
                    <DropdownMenuItem key={sid} onSelect={() => setSpeaker(sid)}>
                      <span
                        className={cn("h-2 w-2 rounded-full", speakerSwatch(sid))}
                        aria-hidden
                      />
                      <span>Speaker {sid}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setRenameSpeaker(true)}>
                    自定义…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={addBookmark}>
                <Bookmark className="h-4 w-4" />
                <span>加书签</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => copyToClipboard(segment.sourceText, "原文")}>
                <Copy className="h-4 w-4" />
                <span>复制原文</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!segment.translatedText}
                onSelect={() =>
                  segment.translatedText &&
                  copyToClipboard(segment.translatedText, "译文")
                }
              >
                <Copy className="h-4 w-4" />
                <span>复制译文</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  copyToClipboard(
                    `${segment.sourceText}\n${segment.translatedText ?? ""}`.trim(),
                    "双语"
                  )
                }
              >
                <Copy className="h-4 w-4" />
                <span>复制双语</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={deleteSegment}
                className="text-red-600 focus:text-red-700"
              >
                <Trash2 className="h-4 w-4" />
                <span>删除</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

export default SegmentCard;
