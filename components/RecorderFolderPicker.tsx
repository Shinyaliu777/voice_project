"use client";

import * as React from "react";
import { Folder as FolderIcon, Inbox, Check } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface FolderOption {
  id: string;
  name: string;
  color: string | null;
}

export interface RecorderFolderPickerProps {
  /** Currently chosen folder id; null = "未归档" (root). */
  value: string | null;
  onChange: (folderId: string | null) => void;
  /** Folders to pick from. The picker auto-fetches /api/folders if
   *  this prop is omitted, but accepting it lets the parent share
   *  the same fetch with adjacent UI (e.g. the dashboard listing). */
  folders?: FolderOption[];
  className?: string;
}

/**
 * Sits next to the language pickers in the Recorder's idle state. The
 * user picks a folder before clicking the mic button; the recorder
 * forwards the choice to POST /api/transcription/sessions so the new
 * session is created INSIDE that folder. Without this picker, every
 * new recording landed in the root and the user had to hunt for it
 * later via the detail page's folder picker.
 *
 * Last choice is persisted in localStorage so the same folder is
 * pre-selected next time. Mirrors the way lecsync's recorder
 * remembers the inviter / source language / target.
 */
const LAST_FOLDER_KEY = "voice-project:lastFolderId";

export function RecorderFolderPicker({
  value,
  onChange,
  folders: foldersProp,
  className,
}: RecorderFolderPickerProps) {
  const [fetched, setFetched] = React.useState<FolderOption[] | null>(null);
  const folders = foldersProp ?? fetched ?? [];

  // Self-fetch when no folder list provided. Quiet on failure — picker
  // just shows the "未归档" option.
  React.useEffect(() => {
    if (foldersProp !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/folders");
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as {
          items?: Array<{ id: string; name: string; color: string | null }>;
        };
        if (cancelled) return;
        setFetched(data.items ?? []);
      } catch {
        /* ignore — fallback to empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [foldersProp]);

  // Rehydrate last choice on mount (only when caller didn't pre-pick).
  React.useEffect(() => {
    if (value !== null) return;
    if (typeof window === "undefined") return;
    try {
      const last = window.localStorage.getItem(LAST_FOLDER_KEY);
      if (last && folders.some((f) => f.id === last)) {
        onChange(last);
      }
    } catch {
      /* ignore corrupt cache */
    }
    // Re-run when folders arrive (initial render typically has folders=[])
  }, [folders, value, onChange]);

  const handlePick = (folderId: string | null) => {
    onChange(folderId);
    if (typeof window !== "undefined") {
      try {
        if (folderId) {
          window.localStorage.setItem(LAST_FOLDER_KEY, folderId);
        } else {
          window.localStorage.removeItem(LAST_FOLDER_KEY);
        }
      } catch {
        /* quota / private-browsing — ignore */
      }
    }
  };

  const current = value ? folders.find((f) => f.id === value) ?? null : null;
  const label = current?.name ?? "未归档";
  const dotColor = current?.color ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="选择保存到的文件夹"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800",
            className
          )}
        >
          {current ? (
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: dotColor ?? "#a1a1aa" }}
            />
          ) : (
            <Inbox className="h-3.5 w-3.5 text-zinc-500" />
          )}
          <span className="max-w-[8rem] truncate">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        <DropdownMenuItem onSelect={() => handlePick(null)}>
          <Inbox className="h-4 w-4 text-zinc-500" />
          <span className="flex-1">未归档</span>
          {value === null ? <Check className="h-4 w-4 text-zinc-500" /> : null}
        </DropdownMenuItem>
        {folders.length > 0 ? <DropdownMenuSeparator /> : null}
        {folders.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => handlePick(f.id)}>
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: f.color ?? "#a1a1aa" }}
            />
            <span className="flex-1 truncate">{f.name}</span>
            {value === f.id ? (
              <Check className="h-4 w-4 text-zinc-500" />
            ) : null}
          </DropdownMenuItem>
        ))}
        {folders.length === 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[11px] text-zinc-500">
              还没有文件夹 — 去「历史记录」创建
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
