"use client";

import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { MinutesView } from "@/components/MinutesView";
import type { MinutesSection } from "@/lib/contracts";

type TabKey = "minutes" | "chat" | "files";

export interface RecorderSidebarProps {
  /** ID of the in-progress recording session. Null until /sessions POST returns. */
  sessionId: string | null;
  /** Folder the recording belongs to, if any. Drives the 文件 tab. */
  folderId?: string | null;
  /** Live minutes state, passed in from Recorder.tsx. */
  minutesSections: MinutesSection[];
  pendingSection: MinutesSection | null;
  minutesStatus: "idle" | "streaming" | "error";
  onRefreshMinutes: () => void;
  className?: string;
}

/**
 * Right-rail panel that lives next to the recording UI — matches lecsync's
 * `RightSidebar` design:
 *   - Three tabs: 纪要 / 对话 / 文件
 *   - Collapsible to a vertical icon strip
 *   - All three tab contents are mounted at once (just hidden), so opening
 *     the chat tab doesn't reset typing-state
 *
 * We render this on lg+ viewports; below that the recorder column takes the
 * full width and there's no right rail. A mobile bottom-sheet equivalent is
 * a separate component we haven't built yet.
 */
export function RecorderSidebar({
  sessionId,
  folderId,
  minutesSections,
  pendingSection,
  minutesStatus,
  onRefreshMinutes,
  className,
}: RecorderSidebarProps) {
  const [tab, setTab] = React.useState<TabKey>("minutes");
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <aside
      className={cn(
        "hidden flex-col border-l border-zinc-200 bg-white transition-[width] lg:flex dark:border-zinc-800 dark:bg-zinc-950",
        collapsed ? "w-12" : "w-96",
        className
      )}
    >
      {/* Header — tab strip OR collapsed icon column */}
      <div
        className={cn(
          "flex shrink-0 items-center border-b border-zinc-100 dark:border-zinc-900",
          collapsed ? "flex-col gap-3 py-3" : "gap-1 px-2 py-2"
        )}
      >
        {!collapsed && (
          <div className="flex flex-1 items-center gap-1 rounded-md bg-zinc-100 p-1 dark:bg-zinc-900">
            <TabButton active={tab === "minutes"} onClick={() => setTab("minutes")}>
              <FileText className="h-3.5 w-3.5" />
              <span>纪要</span>
              {minutesStatus === "streaming" && (
                <Loader2 className="h-3 w-3 animate-spin opacity-60" />
              )}
            </TabButton>
            <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
              <MessageSquare className="h-3.5 w-3.5" />
              <span>对话</span>
            </TabButton>
            <TabButton active={tab === "files"} onClick={() => setTab("files")}>
              <Folder className="h-3.5 w-3.5" />
              <span>文件</span>
            </TabButton>
          </div>
        )}

        {collapsed && (
          <>
            <IconTab
              active={tab === "minutes"}
              onClick={() => {
                setTab("minutes");
                setCollapsed(false);
              }}
              icon={<FileText className="h-4 w-4" />}
            />
            <IconTab
              active={tab === "chat"}
              onClick={() => {
                setTab("chat");
                setCollapsed(false);
              }}
              icon={<MessageSquare className="h-4 w-4" />}
            />
            <IconTab
              active={tab === "files"}
              onClick={() => {
                setTab("files");
                setCollapsed(false);
              }}
              icon={<Folder className="h-4 w-4" />}
            />
          </>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Tab content — all mounted, hidden when inactive */}
      {!collapsed && (
        <>
          <div
            className={cn(
              "flex-1 min-h-0 overflow-y-auto p-3",
              tab !== "minutes" && "hidden"
            )}
          >
            <SidebarMinutes
              sessionId={sessionId}
              sections={minutesSections}
              pendingSection={pendingSection}
              minutesStatus={minutesStatus}
              onRefresh={onRefreshMinutes}
            />
          </div>
          <div
            className={cn(
              "flex flex-1 min-h-0 flex-col",
              tab !== "chat" && "hidden"
            )}
          >
            <SidebarChat sessionId={sessionId} />
          </div>
          <div
            className={cn(
              "flex-1 min-h-0 overflow-y-auto p-3",
              tab !== "files" && "hidden"
            )}
          >
            <SidebarFiles folderId={folderId} />
          </div>
        </>
      )}
    </aside>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-50"
          : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      )}
    >
      {children}
    </button>
  );
}

function IconTab({
  active,
  onClick,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md p-1.5 transition-colors",
        active
          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50"
          : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
      )}
    >
      {icon}
    </button>
  );
}

// ===========================================================================
// Tab: 纪要 (live minutes)
// ===========================================================================

function SidebarMinutes({
  sessionId,
  sections,
  pendingSection,
  minutesStatus,
  onRefresh,
}: {
  sessionId: string | null;
  sections: MinutesSection[];
  pendingSection: MinutesSection | null;
  minutesStatus: "idle" | "streaming" | "error";
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {minutesStatus === "streaming"
            ? "正在生成纪要…"
            : minutesStatus === "error"
              ? "上次失败，请重试"
              : sections.length === 0
                ? "等待第一段内容"
                : `${sections.length} 个章节`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRefresh}
          disabled={!sessionId || minutesStatus === "streaming"}
          aria-label="立即刷新"
          title="立即刷新"
        >
          {minutesStatus === "streaming" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {sections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 p-6 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          录够几句话后会自动生成要点
        </div>
      ) : (
        <MinutesView
          sections={sections}
          pendingLastSection={pendingSection !== null}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Tab: 对话 (slim chat scoped to current recording)
// ===========================================================================

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

function SidebarChat({ sessionId }: { sessionId: string | null }) {
  // Lazy-created ChatSession bound to this recording. Stored in a ref so
  // re-renders don't lose it.
  const chatSessionIdRef = React.useRef<string | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    // Reset chat when the underlying recording changes.
    chatSessionIdRef.current = null;
    setMessages([]);
    setInput("");
  }, [sessionId]);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const clear = React.useCallback(() => {
    chatSessionIdRef.current = null;
    setMessages([]);
  }, []);

  const send = React.useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    if (!sessionId) {
      toast.error("等录音开始后再问");
      return;
    }
    setSending(true);

    try {
      // Lazy chat session creation, bound to the recording.
      let cid = chatSessionIdRef.current;
      if (!cid) {
        const resp = await fetch("/api/chat/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            title: trimmed.slice(0, 40),
          }),
        });
        if (!resp.ok) {
          throw new Error(`chat session ${resp.status}`);
        }
        const created = (await resp.json()) as { id: string };
        cid = created.id;
        chatSessionIdRef.current = cid;
      }

      const userId = `u-${Date.now()}`;
      const asstId = `a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: trimmed },
        { id: asstId, role: "assistant", content: "", streaming: true },
      ]);
      setInput("");

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatSessionId: cid, message: trimmed }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`/api/chat -> ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let assembled = "";
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const evt of events) {
          const line = evt.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let payload: { type: string; value?: string; message?: string };
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (payload.type === "text" && payload.value) {
            assembled += payload.value;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId ? { ...m, content: assembled } : m
              )
            );
          } else if (payload.type === "done") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId ? { ...m, streaming: false } : m
              )
            );
            break outer;
          } else if (payload.type === "error") {
            throw new Error(payload.message ?? "chat failed");
          }
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "chat failed");
      setMessages((prev) =>
        prev.filter((m) => !(m.role === "assistant" && m.streaming))
      );
    } finally {
      setSending(false);
    }
  }, [input, sending, sessionId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <>
      {/* Sub-header for the chat tab */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-900">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {sessionId ? "有关这段录音提问" : "等录音开始后再问"}
        </span>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-zinc-400 hover:text-rose-500"
              onClick={clear}
              title="清空对话"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={clear}
            title="新对话"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Message stream */}
      <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageSquare className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
            <p className="text-xs text-zinc-500">向 AI 提问关于转录内容的问题</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "flex",
                  m.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
                    m.role === "user"
                      ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
                  )}
                >
                  {m.role === "assistant" ? (
                    m.content ? (
                      <MarkdownMessage content={m.content} />
                    ) : (
                      <span className="text-zinc-400">…</span>
                    )
                  ) : (
                    m.content
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-zinc-100 p-2 dark:border-zinc-900">
        <div className="flex items-end gap-1 rounded-xl border border-zinc-200 bg-white p-1.5 dark:border-zinc-800 dark:bg-zinc-950">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={sessionId ? "问问这段录音…" : "等录音开始后再问"}
            rows={1}
            disabled={!sessionId || sending}
            className="min-h-[28px] max-h-32 flex-1 resize-none bg-transparent text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
          />
          <Button
            type="button"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-full"
            disabled={!input.trim() || !sessionId || sending}
            onClick={send}
            aria-label="发送"
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// Tab: 文件 (folder docs picker placeholder)
// ===========================================================================

function SidebarFiles({ folderId }: { folderId?: string | null }) {
  // Folder integration in the live-recorder UI is not wired yet — we mirror
  // lecsync's empty state: "请先选择文件夹 / 录制时选择文件夹后可查看参考文件".
  // When a folder gets bound to the session, we'll list its documents here.
  if (!folderId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Folder className="h-6 w-6 text-zinc-300 dark:text-zinc-700" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          请先选择文件夹
        </p>
        <p className="max-w-[260px] text-xs text-zinc-500 dark:text-zinc-400">
          录制时选择文件夹后，这里会展示文件夹里的参考课件，AI 问答会自动用上。
        </p>
      </div>
    );
  }
  return (
    <p className="text-xs text-zinc-500">
      文件夹 {folderId} 的课件 — 列表 UI 即将上线。
    </p>
  );
}

export default RecorderSidebar;
