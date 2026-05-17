"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  Copy,
  Globe,
  Lightbulb,
  Loader2,
  MessageSquare,
  Mic,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import {
  LANGUAGE_NAMES,
  type ChatMessageDTO,
  type ChatSessionDTO,
  type SessionDTO,
} from "@/lib/contracts";

const FLAGS: Record<string, string> = {
  en: "🇺🇸",
  zh: "🇨🇳",
  ja: "🇯🇵",
  es: "🇪🇸",
  fr: "🇫🇷",
  de: "🇩🇪",
  ko: "🇰🇷",
  ru: "🇷🇺",
  it: "🇮🇹",
  pt: "🇵🇹",
};

type RecordingCard = Pick<
  SessionDTO,
  "id" | "title" | "sourceLang" | "targetLang" | "durationMs" | "createdAt"
>;

type Props =
  | {
      mode: "new";
      chatList: ChatSessionDTO[];
      recordings: RecordingCard[];
      prefillRecordingId: string | null;
      prefillRecordingTitle: string | null;
    }
  | {
      mode: "existing";
      chatList: ChatSessionDTO[];
      recordings: RecordingCard[];
      chatSession: ChatSessionDTO;
      initialMessages: ChatMessageDTO[];
      boundRecordingTitle: string | null;
    };

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** True while the assistant is still streaming this message. */
  streaming?: boolean;
}

const QUICK_PROMPTS_NEW = [
  "跟我讲一下 AI 的原理",
  "推荐一种学习方法",
  "帮我学习外语",
];
const QUICK_PROMPTS_BOUND = ["这段录音讲了什么？", "总结成 5 个要点"];

function fmtDuration(ms: number | null): string {
  if (!ms || ms < 1000) return "—";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}秒`;
  return `${m}分${r > 0 ? `${r}秒` : ""}`;
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `约 ${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return d.toLocaleDateString();
}

/**
 * Chat page UI — modelled on lecsync.com/zh/dashboard/chat/new.
 *
 * Layout: header with title + new-chat button → message stream (or empty
 * state with recording shortcuts + quick prompts) → bottom composer.
 */
export function ChatPanel(props: Props) {
  const router = useRouter();
  const isNew = props.mode === "new";

  const [boundRecordingId, setBoundRecordingId] = React.useState<string | null>(
    isNew ? props.prefillRecordingId : null
  );
  const [boundRecordingTitle, setBoundRecordingTitle] = React.useState<string | null>(
    isNew ? props.prefillRecordingTitle : props.boundRecordingTitle
  );

  const [messages, setMessages] = React.useState<UIMessage[]>(() =>
    isNew
      ? []
      : props.initialMessages.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
        }))
  );
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const chatSessionId = isNew ? null : props.chatSession.id;

  const send = React.useCallback(
    async (
      text: string,
      opts?: {
        /**
         * When set, the user message is NOT re-appended and the assistant
         * message with this id is replaced (used by 重新生成). The caller
         * should only pass this when the prior user message is already
         * persisted on the server.
         */
        replaceAssistantId?: string;
      }
    ) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setSending(true);

      const replaceAssistantId = opts?.replaceAssistantId;

      try {
        // Lazily create a ChatSession when this is the first message in a
        // "new" chat. We redirect after streaming completes so users see the
        // first response under the original URL — avoids a mid-stream remount.
        let sid = chatSessionId;
        if (!sid) {
          // Only include sessionId when we actually have one — the route's
          // zod schema is `z.string().optional()` which rejects null.
          const body: { sessionId?: string; title: string } = {
            title: trimmed.slice(0, 40),
          };
          if (boundRecordingId) body.sessionId = boundRecordingId;
          const resp = await fetch("/api/chat/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!resp.ok) {
            const txt = await resp.text().catch(() => "");
            throw new Error(`chat session create ${resp.status}: ${txt.slice(0, 100)}`);
          }
          const created = (await resp.json()) as ChatSessionDTO;
          sid = created.id;
        }

        // Optimistic user message + placeholder for the assistant stream.
        // When regenerating, we reuse the existing assistant id (no new user
        // bubble) and clear its content so the streaming UI takes over.
        const asstId = replaceAssistantId ?? `a-${Date.now()}`;
        if (replaceAssistantId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === replaceAssistantId
                ? { ...m, content: "", streaming: true }
                : m
            )
          );
        } else {
          const userId = `u-${Date.now()}`;
          setMessages((prev) => [
            ...prev,
            { id: userId, role: "user", content: trimmed },
            { id: asstId, role: "assistant", content: "", streaming: true },
          ]);
          setInput("");
        }

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatSessionId: sid,
            message: trimmed,
            ...(replaceAssistantId ? { regenerate: true } : {}),
          }),
        });
        if (!res.ok || !res.body) {
          throw new Error(`/api/chat -> ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let assembled = "";
        let streamError: string | null = null;

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const evt of events) {
            const dataLine = evt
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            let payload:
              | { type: "text"; value: string }
              | { type: "done"; messageId: string }
              | { type: "error"; message: string };
            try {
              payload = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if (payload.type === "text") {
              assembled += payload.value;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstId ? { ...m, content: assembled } : m
                )
              );
            } else if (payload.type === "done") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === asstId
                    ? { ...m, content: assembled, streaming: false, id: payload.messageId }
                    : m
                )
              );
              break outer;
            } else if (payload.type === "error") {
              streamError = payload.message;
              break outer;
            }
          }
        }

        if (streamError) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstId
                ? {
                    ...m,
                    content: assembled || `出错：${streamError}`,
                    streaming: false,
                  }
                : m
            )
          );
          toast.error(streamError);
        }

        // If we just created the chat, swap to its real URL so refreshes work.
        if (!chatSessionId && sid) {
          router.replace(`/dashboard/chat/${sid}`);
        } else {
          router.refresh();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "发送失败";
        toast.error(msg);
        if (replaceAssistantId) {
          // Leave the original assistant bubble visible but stop the spinner.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === replaceAssistantId ? { ...m, streaming: false } : m
            )
          );
        } else {
          setMessages((prev) =>
            prev.filter((m) => !(m.role === "assistant" && m.streaming))
          );
        }
      } finally {
        setSending(false);
      }
    },
    [chatSessionId, boundRecordingId, sending, router]
  );

  /**
   * Regenerate the assistant message at `asstMessageId` by re-sending the
   * preceding user message. Replaces the existing bubble in-place rather than
   * appending a new turn.
   */
  const regenerate = React.useCallback(
    (asstMessageId: string) => {
      if (sending) return;
      // Find the user message immediately preceding this assistant message.
      let prevUserContent: string | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].id !== asstMessageId) continue;
        for (let j = i - 1; j >= 0; j--) {
          if (messages[j].role === "user") {
            prevUserContent = messages[j].content;
            break;
          }
        }
        break;
      }
      if (!prevUserContent) {
        toast.error("找不到上一条用户消息");
        return;
      }
      void send(prevUserContent, { replaceAssistantId: asstMessageId });
    },
    [messages, send, sending]
  );

  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败");
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const showEmptyState = messages.length === 0;
  const headerTitle = isNew
    ? "新对话"
    : props.chatSession.title || "对话";
  const subtitle = boundRecordingTitle ? `From: ${boundRecordingTitle}` : null;
  const quickPrompts = boundRecordingTitle
    ? QUICK_PROMPTS_BOUND
    : QUICK_PROMPTS_NEW;

  return (
    <div className="relative flex h-[calc(100vh-3rem)] flex-col bg-white dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-6 py-3 dark:border-zinc-900">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {headerTitle}
          </h1>
          {subtitle ? (
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
              <Mic className="h-3 w-3 shrink-0" />
              <span className="truncate">{subtitle}</span>
            </p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          asChild
          className="shrink-0 gap-1.5"
        >
          <Link href="/dashboard/chat/new">
            <Plus className="h-4 w-4" />
            <span>新对话</span>
          </Link>
        </Button>
      </div>

      {/* Body — message stream OR empty state.
       *
       * `justify-end` makes the message column stack from the bottom near
       * the composer when only the first user message is in flight, instead
       * of clinging to the top of a tall scroll region.
       */}
      <div
        ref={scrollerRef}
        className="flex flex-1 flex-col justify-end overflow-y-auto px-6 py-6"
      >
        {showEmptyState ? (
          <EmptyState
            boundRecordingTitle={boundRecordingTitle}
            recordings={props.recordings}
            disabled={sending}
            onPickRecording={(r) => {
              setBoundRecordingId(r.id);
              setBoundRecordingTitle(r.title);
              router.replace(`/dashboard/chat/new?sessionId=${r.id}`);
            }}
          />
        ) : (
          <ul className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {messages.map((m) => {
              const isUser = m.role === "user";
              const isAssistantPending = !isUser && m.streaming;
              return (
                <li
                  key={m.id}
                  className={cn(
                    "group/msg flex flex-col",
                    isUser ? "items-end" : "items-start"
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                      isUser
                        ? "whitespace-pre-wrap bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                        : "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
                    )}
                  >
                    {isUser ? (
                      m.content
                    ) : m.content ? (
                      <MarkdownMessage content={m.content} />
                    ) : m.streaming ? (
                      <ThinkingDots />
                    ) : (
                      ""
                    )}
                  </div>
                  {/* Hover toolbar — hidden while the assistant is streaming
                   * to avoid letting users hit 重新生成 mid-stream. */}
                  {!isAssistantPending && m.content ? (
                    <MessageToolbar
                      align={isUser ? "end" : "start"}
                      onCopy={() => void copyToClipboard(m.content)}
                      onRegenerate={
                        isUser ? undefined : () => regenerate(m.id)
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-100 px-4 pb-4 pt-3 dark:border-zinc-900"
      >
        <div className="mx-auto max-w-3xl">
          {showEmptyState && quickPrompts.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {quickPrompts.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                  onClick={() => void send(q)}
                  disabled={sending}
                >
                  {q}
                </button>
              ))}
            </div>
          ) : null}

          <div
            className={cn(
              "flex items-end gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2 transition-colors focus-within:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900",
              sending && "opacity-80"
            )}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={boundRecordingTitle ? "问问这段录音…" : "输入你的问题…"}
              rows={1}
              disabled={sending}
              className="min-h-[36px] max-h-40 flex-1 resize-none bg-transparent text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim() || sending}
              className="h-9 w-9 shrink-0 rounded-full"
              aria-label="发送"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>

          <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-400">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> Basic
              </span>
              <span className="inline-flex items-center gap-1 opacity-50">
                <Globe className="h-3 w-3" /> 联网
              </span>
              <span className="inline-flex items-center gap-1 opacity-50">
                <Lightbulb className="h-3 w-3" /> 思考
              </span>
            </div>
            <span>Enter 发送 · Shift+Enter 换行</span>
          </div>
        </div>
      </form>
    </div>
  );
}

function EmptyState({
  boundRecordingTitle,
  recordings,
  disabled,
  onPickRecording,
}: {
  boundRecordingTitle: string | null;
  recordings: RecordingCard[];
  disabled: boolean;
  onPickRecording: (r: RecordingCard) => void;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
        <MessageSquare className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {boundRecordingTitle ? "开始对话" : "有什么可以帮到你？"}
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {boundRecordingTitle
            ? "向 AI 提问关于转录内容的问题"
            : "我可以解答问题、写作、分析等"}
        </p>
      </div>

      {!boundRecordingTitle && recordings.length > 0 ? (
        <div className="w-full">
          <p className="mb-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
            或从一段录音继续
          </p>
          <ul className="flex flex-col gap-2">
            {recordings.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onPickRecording(r)}
                  className="group flex w-full items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/70"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {r.title}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="inline-flex items-center gap-1">
                        {FLAGS[r.sourceLang] ?? "🌐"}
                        {LANGUAGE_NAMES[r.sourceLang as keyof typeof LANGUAGE_NAMES] ?? r.sourceLang.toUpperCase()}
                        <span>→</span>
                        {FLAGS[r.targetLang] ?? "🌐"}
                        {LANGUAGE_NAMES[r.targetLang as keyof typeof LANGUAGE_NAMES] ?? r.targetLang.toUpperCase()}
                      </span>
                      <span>·</span>
                      <span>{fmtDuration(r.durationMs)}</span>
                      <span>·</span>
                      <span>{fmtRelative(r.createdAt)}</span>
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-hover:translate-x-0.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1 text-zinc-400">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
    </span>
  );
}

/**
 * Small icon-only action row that fades in under a message on hover.
 * Mirrors the lecsync.com toolbar (复制 for both roles, plus 重新生成 for
 * assistant messages).
 */
function MessageToolbar({
  align,
  onCopy,
  onRegenerate,
}: {
  align: "start" | "end";
  onCopy: () => void;
  onRegenerate?: () => void;
}) {
  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-0.5 opacity-0 transition-opacity",
        "group-hover/msg:opacity-100 focus-within:opacity-100",
        align === "end" ? "self-end" : "self-start"
      )}
    >
      <button
        type="button"
        onClick={onCopy}
        aria-label="复制"
        title="复制"
        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      {onRegenerate ? (
        <button
          type="button"
          onClick={onRegenerate}
          aria-label="重新生成"
          title="重新生成"
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export default ChatPanel;
