"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, MessageSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import type { ChatSessionDTO } from "@/lib/contracts";

const STORAGE_KEY = "sidebar:chat-history:expanded";
const MAX_ITEMS = 12;

interface SidebarChatHistoryProps {
  /**
   * Class applied to each row so it matches the spacing of the sibling nav
   * entries. Mirrors the `itemClassName` style in SidebarNav.
   */
  parentItemClassName: string;
  /** Top entry (the existing "对话" link) class for active state. */
  topItemActiveClassName: string;
  topItemInactiveClassName: string;
}

/**
 * Inline expandable chat history list inside the sidebar.
 *
 *  - "对话" remains a link to /dashboard/chat/new (so clicking the label
 *    still creates a new chat, matching the previous behavior).
 *  - A chevron next to the label toggles the inline list of recent
 *    ChatSessions (last MAX_ITEMS, ordered by updatedAt desc, fetched
 *    client-side from GET /api/chat/sessions).
 *  - Each item links to /dashboard/chat/[id]; hover reveals a trash icon
 *    that DELETEs the session via /api/chat/sessions/[id] and refreshes.
 *  - Expand state is persisted in localStorage.
 */
export function SidebarChatHistory({
  parentItemClassName,
  topItemActiveClassName,
  topItemInactiveClassName,
}: SidebarChatHistoryProps) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();

  // Default: collapsed. Restored from localStorage on mount. We avoid reading
  // localStorage during the initial render to keep SSR/CSR markup in sync.
  const [expanded, setExpanded] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  const [items, setItems] = React.useState<ChatSessionDTO[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  // Restore expanded state on mount.
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === "1") setExpanded(true);
    } catch {
      // ignore — fall through with default collapsed
    }
    setHydrated(true);
  }, []);

  // Persist expanded state whenever it changes (post-hydration).
  React.useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, expanded ? "1" : "0");
    } catch {
      // ignore
    }
  }, [expanded, hydrated]);

  const loadSessions = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chat/sessions", { cache: "no-store" });
      if (!res.ok) throw new Error(`GET /api/chat/sessions -> ${res.status}`);
      const json = (await res.json()) as { items: ChatSessionDTO[] };
      setItems((json.items ?? []).slice(0, MAX_ITEMS));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加载对话失败";
      toast.error(msg);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch when expanding for the first time, and refresh when pathname
  // changes while expanded (so a newly-created chat appears).
  React.useEffect(() => {
    if (!expanded) return;
    void loadSessions();
  }, [expanded, pathname, loadSessions]);

  const handleDelete = React.useCallback(
    async (id: string) => {
      if (deletingId) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(
            `DELETE /api/chat/sessions/${id} -> ${res.status}${txt ? `: ${txt.slice(0, 80)}` : ""}`
          );
        }
        // Optimistic local removal, then re-fetch (and re-route if we deleted
        // the chat currently being viewed).
        setItems((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
        toast.success("已删除对话");
        if (pathname.startsWith(`/dashboard/chat/${id}`)) {
          router.push("/dashboard/chat/new");
        } else {
          router.refresh();
        }
        void loadSessions();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "删除失败";
        toast.error(msg);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, pathname, router, loadSessions]
  );

  const isChatActive = pathname.startsWith("/dashboard/chat");
  const isNewChatActive = pathname === "/dashboard/chat/new";

  return (
    <>
      <div className="flex items-stretch gap-0.5">
        <Link
          href="/dashboard/chat/new"
          className={cn(
            parentItemClassName,
            "flex-1",
            isNewChatActive
              ? topItemActiveClassName
              : topItemInactiveClassName
          )}
        >
          <MessageSquare className="h-4 w-4 shrink-0" />
          <span>对话</span>
        </Link>
        <button
          type="button"
          aria-label={expanded ? "收起对话列表" : "展开对话列表"}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "flex w-7 shrink-0 items-center justify-center rounded-[10px] text-zinc-500 transition-colors",
            "hover:bg-zinc-200/40 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
            isChatActive && "text-zinc-700 dark:text-zinc-300"
          )}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {expanded ? (
        <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
          {loading && items === null ? (
            <li className="px-3 py-1.5 text-xs text-zinc-400">加载中…</li>
          ) : items && items.length === 0 ? (
            <li className="px-3 py-1.5 text-xs text-zinc-400">暂无对话</li>
          ) : (
            (items ?? []).map((s) => {
              const active = pathname === `/dashboard/chat/${s.id}`;
              const displayTitle = (s.title ?? "").trim() || "Untitled";
              return (
                <li key={s.id} className="group/chat-item relative">
                  <Link
                    href={`/dashboard/chat/${s.id}`}
                    className={cn(
                      "flex items-center gap-2 rounded-[10px] py-1.5 pl-2.5 pr-9 text-xs transition-colors",
                      active
                        ? "bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                        : "text-zinc-600 hover:bg-zinc-200/40 dark:text-zinc-400 dark:hover:bg-zinc-800/60"
                    )}
                    title={displayTitle}
                  >
                    <span className="truncate">{displayTitle}</span>
                  </Link>
                  <button
                    type="button"
                    aria-label={`删除对话：${displayTitle}`}
                    disabled={deletingId === s.id}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleDelete(s.id);
                    }}
                    className={cn(
                      "absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 opacity-0 transition-opacity",
                      "hover:bg-zinc-300/60 hover:text-zinc-700",
                      "dark:hover:bg-zinc-700 dark:hover:text-zinc-200",
                      "group-hover/chat-item:opacity-100 focus:opacity-100",
                      deletingId === s.id && "opacity-100"
                    )}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </>
  );
}

export default SidebarChatHistory;
