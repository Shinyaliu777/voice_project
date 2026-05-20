"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SUPPORTED_LANGUAGES,
  type SessionDTO,
  type SupportedLanguage,
} from "@/lib/contracts";
import { cn } from "@/lib/utils";

const FLAGS: Record<SupportedLanguage, string> = {
  en: "🇺🇸",
  zh: "🇨🇳",
  ja: "🇯🇵",
  es: "🇪🇸",
  fr: "🇫🇷",
  de: "🇩🇪",
  ar: "🇸🇦",
  hi: "🇮🇳",
  pt: "🇵🇹",
  ko: "🇰🇷",
  ru: "🇷🇺",
  it: "🇮🇹",
  tr: "🇹🇷",
  vi: "🇻🇳",
  th: "🇹🇭",
  nl: "🇳🇱",
  pl: "🇵🇱",
  sv: "🇸🇪",
  id: "🇮🇩",
  cs: "🇨🇿",
  el: "🇬🇷",
  hu: "🇭🇺",
  ro: "🇷🇴",
  uk: "🇺🇦",
};

/** Flag emoji for a BCP-47 code; falls back to a neutral flag for unknown codes. */
export function flagFor(code: string): string {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(code)
    ? FLAGS[code as SupportedLanguage]
    : "🏳️";
}

// `displaySessionTitle` / `formatDuration` moved to lib/session-display.ts
// so server components can use them too. Re-exported here for source
// compatibility with existing callers that imported from this file.
import {
  displaySessionTitle,
  formatDuration,
} from "@/lib/session-display";
export { displaySessionTitle, formatDuration };

/** 刚刚 / N 分钟前 / 约 N 小时前 / N 天前 / YYYY-MM-DD */
export function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `约 ${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

type StatusInfo = {
  label: string;
  className: string;
  pulse?: boolean;
};

function statusInfo(status: SessionDTO["status"]): StatusInfo {
  switch (status) {
    case "ready":
      return {
        label: "已完成",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-200/60",
      };
    case "recording":
      return {
        label: "录音中",
        className: "bg-rose-50 text-rose-700 ring-rose-200/60",
        pulse: true,
      };
    case "uploading":
      return {
        label: "上传中",
        className: "bg-amber-50 text-amber-700 ring-amber-200/60",
      };
    case "error":
      return {
        label: "出错",
        className: "bg-red-50 text-red-700 ring-red-200/60",
      };
    default:
      return {
        label: "草稿",
        className: "bg-zinc-100 text-zinc-700 ring-zinc-200/60",
      };
  }
}

export interface SessionCardProps {
  session: SessionDTO;
}

export function SessionCard({ session }: SessionCardProps) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [title, setTitle] = React.useState(session.title || "");
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const status = statusInfo(session.status);

  const openRename = () => {
    setTitle(session.title || "");
    setRenameOpen(true);
  };

  const saveRename = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error("标题不能为空");
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch(
        `/api/transcription/sessions/${session.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        }
      );
      if (!resp.ok) {
        toast.error(`重命名失败 (${resp.status})`);
        return;
      }
      toast.success("已重命名");
      setRenameOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重命名失败");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const resp = await fetch(
        `/api/transcription/sessions/${session.id}`,
        { method: "DELETE" }
      );
      if (!resp.ok && resp.status !== 204) {
        toast.error(`删除失败 (${resp.status})`);
        return;
      }
      toast.success("已删除");
      setDeleteOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="group relative rounded-[10px] border border-zinc-100 bg-white transition hover:border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800">
        <Link
          href={`/dashboard/history/${session.id}`}
          className="block px-4 py-3 pr-12"
        >
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
              {displaySessionTitle(session.title, session.createdAt)}
            </span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                status.className
              )}
            >
              {status.pulse ? (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-500" />
                </span>
              ) : null}
              {status.label}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span
              className="inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              aria-label={`${session.sourceLang} 到 ${session.targetLang}`}
            >
              <span aria-hidden>{flagFor(session.sourceLang)}</span>
              <span className="uppercase">{session.sourceLang}</span>
              <span className="text-zinc-400">→</span>
              <span aria-hidden>{flagFor(session.targetLang)}</span>
              <span className="uppercase">{session.targetLang}</span>
            </span>
            <span>{formatDuration(session.durationMs)}</span>
            <span>{formatRelative(session.createdAt)}</span>
            {session.hasMinutes ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-inset ring-violet-200/60">
                <CheckCircle2 className="h-3 w-3" />
                <span>纪要</span>
              </span>
            ) : null}
            {session.segmentCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 ring-1 ring-inset ring-sky-200/60">
                <MessageSquare className="h-3 w-3" />
                <span>{session.segmentCount} 句</span>
              </span>
            ) : null}
          </div>
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              aria-label="录音操作"
              className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-700 focus:opacity-100"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                openRename();
              }}
            >
              <Pencil className="h-4 w-4" />
              <span>重命名</span>
            </DropdownMenuItem>
            {/* "移动到文件夹" lived here as a disabled placeholder.
                The session detail page has a working folder picker —
                rather than leave a dead row in the dropdown, drop it
                and let users move from the detail page. If we want to
                re-add it later, lift the folder list to this component
                and reuse SessionFolderPicker. */}
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setDeleteOpen(true);
              }}
              className="text-rose-600 focus:text-rose-700"
            >
              <Trash2 className="h-4 w-4" />
              <span>删除</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重命名录音</DialogTitle>
            <DialogDescription>
              修改这段录音的标题（不会影响转录内容）
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`rename-${session.id}`}>标题</Label>
            <Input
              id={`rename-${session.id}`}
              autoFocus
              value={title}
              placeholder="请输入新标题"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveRename();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRenameOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={saveRename} disabled={saving || !title.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <span>保存</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除录音</DialogTitle>
            <DialogDescription>
              确定删除「{displaySessionTitle(session.title, session.createdAt)}
              」？这段录音的转录、纪要和书签也会一并删除，操作无法撤销。
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

export default SessionCard;
