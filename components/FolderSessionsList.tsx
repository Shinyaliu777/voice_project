"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  CheckSquare,
  Combine,
  Filter,
  FolderInput,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { displaySessionTitle, formatDuration } from "@/lib/session-display";
import { cn } from "@/lib/utils";

interface SessionRow {
  id: string;
  title: string;
  sourceLang: string;
  targetLang: string;
  status: string;
  createdAt: string;
  segmentCount: number;
  durationMs: number | null;
}

interface FolderChoice {
  id: string;
  name: string;
  color: string | null;
}

export interface FolderSessionsListProps {
  /** Sessions in this folder. */
  sessions: SessionRow[];
  /** All of the user's folders — for the "move to" action. */
  folders: FolderChoice[];
  /** Folder id currently displayed, so we can filter it out of the
   *  move-to targets. null when on the unfiled view. */
  currentFolderId: string | null;
}

type StatusFilter = "all" | "ready" | "uploading" | "recording" | "idle" | "error";

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: "全部状态",
  ready: "已完成",
  uploading: "上传中",
  recording: "录制中",
  idle: "草稿",
  error: "失败",
};

function statusInfo(s: string): { label: string; tone: string } {
  switch (s) {
    case "ready":
      return {
        label: "已完成",
        tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
      };
    case "uploading":
      return {
        label: "上传中",
        tone: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
      };
    case "recording":
      return {
        label: "录制中",
        tone: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
      };
    case "error":
      return {
        label: "失败",
        tone: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
      };
    default:
      return {
        label: "草稿",
        tone: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
      };
  }
}

/**
 * Folder-page session list with multi-select + batch actions + status
 * filter. Wraps the formerly inline server-side <ul> so the three
 * top buttons (选择 / 合并 / 全部状态) can actually do things.
 *
 * Implemented batch actions:
 *   - Move to another folder (or to unfiled)
 *   - Delete (with confirm)
 *
 * Deferred:
 *   - Merge (合并) — needs server-side stitching of segments + audio
 *     chunks across N sessions; out of scope tonight. Button shows
 *     "即将推出" toast.
 */
export function FolderSessionsList({
  sessions,
  folders,
  currentFolderId,
}: FolderSessionsListProps) {
  const router = useRouter();
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const filtered = React.useMemo(() => {
    if (statusFilter === "all") return sessions;
    return sessions.filter((s) => s.status === statusFilter);
  }, [sessions, statusFilter]);

  const exitSelect = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(filtered.map((s) => s.id)));
  };

  const handleMove = async (targetFolderId: string | null) => {
    if (busy || selectedIds.size === 0) return;
    setBusy(true);
    try {
      // Fire all PATCHes in parallel; gather failures.
      const results = await Promise.allSettled(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/transcription/sessions/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderId: targetFolderId }),
          })
        )
      );
      const failures = results.filter(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
      );
      if (failures.length > 0) {
        toast.error(`${failures.length} 个移动失败`);
      } else {
        toast.success(`已移动 ${selectedIds.size} 个录音`);
      }
      setMoveOpen(false);
      exitSelect();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移动失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (busy || selectedIds.size === 0) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        Array.from(selectedIds).map((id) =>
          fetch(`/api/transcription/sessions/${id}`, { method: "DELETE" })
        )
      );
      const failures = results.filter(
        (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
      );
      if (failures.length > 0) {
        toast.error(`${failures.length} 个删除失败`);
      } else {
        toast.success(`已删除 ${selectedIds.size} 个录音`);
      }
      setDeleteOpen(false);
      exitSelect();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const moveTargets = folders.filter((f) => f.id !== currentFolderId);

  return (
    <>
      {/* Toolbar */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {!selectMode ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectMode(true)}
              disabled={sessions.length === 0}
            >
              <CheckSquare className="h-4 w-4" />
              选择
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast(
                  "合并多个录音：即将推出。当前可用「选择」批量删除或移动。"
                )
              }
            >
              <Combine className="h-4 w-4" />
              合并
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Filter className="h-4 w-4" />
                  {STATUS_LABEL[statusFilter]}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={statusFilter}
                  onValueChange={(v) => setStatusFilter(v as StatusFilter)}
                >
                  {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((k) => (
                    <DropdownMenuRadioItem key={k} value={k}>
                      {STATUS_LABEL[k]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto">
              <Button asChild size="sm">
                <Link href="/dashboard">新建录音</Link>
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={exitSelect}>
              <X className="h-4 w-4" />
              退出选择
            </Button>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              已选 {selectedIds.size} / {filtered.length}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={selectAll}
              disabled={
                filtered.length === 0 || selectedIds.size === filtered.length
              }
            >
              全选
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMoveOpen(true)}
                disabled={selectedIds.size === 0 || moveTargets.length === 0}
              >
                <FolderInput className="h-4 w-4" />
                移动到…
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                disabled={selectedIds.size === 0}
              >
                <Trash2 className="h-4 w-4" />
                删除
              </Button>
            </div>
          </>
        )}
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          {sessions.length === 0
            ? currentFolderId === null
              ? "暂无未归档的录音"
              : "这个文件夹里还没有录音"
            : "没有匹配的录音 — 试试改一下筛选"}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((s) => {
              const status = statusInfo(s.status);
              const selected = selectedIds.has(s.id);
              return (
                <li key={s.id}>
                  <div
                    className={cn(
                      "flex items-center gap-4 px-4 py-3 transition-colors",
                      selectMode &&
                        "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/60",
                      selected && "bg-zinc-50 dark:bg-zinc-800/60"
                    )}
                    onClick={selectMode ? () => toggle(s.id) : undefined}
                  >
                    {selectMode ? (
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggle(s.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 shrink-0 cursor-pointer"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                          {displaySessionTitle(s.title, s.createdAt)}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                            status.tone
                          )}
                        >
                          {status.label}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                          {s.sourceLang.toUpperCase()}
                          <ArrowLeftRight className="mx-1 inline h-3 w-3" />
                          {s.targetLang.toUpperCase()}
                        </span>
                        <span>{s.segmentCount} 段</span>
                        {s.durationMs ? (
                          <span>{formatDuration(s.durationMs)}</span>
                        ) : null}
                        <span>{formatRelativeShort(s.createdAt)}</span>
                      </div>
                    </div>
                    {!selectMode ? (
                      <Link
                        href={`/dashboard/history/${s.id}`}
                        className="shrink-0 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                      >
                        查看 →
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Move-to dialog */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              移动 {selectedIds.size} 个录音到…
            </DialogTitle>
            <DialogDescription>
              选一个目标文件夹。移到「未归档」会回到根目录。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] overflow-y-auto py-1">
            {currentFolderId !== null ? (
              <button
                type="button"
                onClick={() => void handleMove(null)}
                disabled={busy}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <span className="inline-block h-3 w-3 shrink-0 rounded-full bg-zinc-300" />
                <span className="flex-1 text-zinc-900 dark:text-zinc-100">
                  未归档
                </span>
              </button>
            ) : null}
            {moveTargets.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => void handleMove(folder.id)}
                disabled={busy}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: folder.color ?? "#a1a1aa" }}
                />
                <span className="flex-1 truncate text-zinc-900 dark:text-zinc-100">
                  {folder.name}
                </span>
              </button>
            ))}
          </div>
          {busy ? (
            <div className="flex items-center justify-center pb-3 text-xs text-zinc-500">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> 处理中
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              删除 {selectedIds.size} 个录音？
            </DialogTitle>
            <DialogDescription>
              录音、转录、音频文件、纪要将被永久删除，无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={busy}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatRelativeShort(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diffMin = Math.floor((Date.now() - ts) / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hr = Math.floor(diffMin / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
