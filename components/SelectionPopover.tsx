"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  BookOpenText,
  Copy,
  Loader2,
  MessageCircleQuestion,
  PlusCircle,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface SelectionPopoverProps {
  /** Ref to the container whose internal selection should trigger the popover */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Source language of the transcript text. Default "en". */
  sourceLanguage?: string;
  /** Target language the LLM should answer in. Default "zh". */
  targetLanguage?: string;
  /** Optional session id to associate created flashcards with */
  sessionId?: string;
}

type Mode = "actions" | "lookup" | "ask";

interface PopoverState {
  rect: DOMRect | null;
  text: string;
}

const POPOVER_OFFSET = 8;
const POPOVER_WIDTH = 360; // visual cap; tailwind class controls inline panels

/**
 * Floating popover that listens to user text selection inside a host
 * container. Renders into document.body via portal so it never gets clipped
 * by ancestors with overflow:hidden / transforms.
 */
export function SelectionPopover({
  containerRef,
  sourceLanguage = "en",
  targetLanguage = "zh",
  sessionId,
}: SelectionPopoverProps) {
  const [mounted, setMounted] = React.useState(false);
  const [selection, setSelection] = React.useState<PopoverState>({
    rect: null,
    text: "",
  });
  const [mode, setMode] = React.useState<Mode>("actions");
  const [streaming, setStreaming] = React.useState(false);
  const [answer, setAnswer] = React.useState("");
  const [questionInput, setQuestionInput] = React.useState("");
  const [savingFlashcard, setSavingFlashcard] = React.useState(false);

  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // Mount guard so createPortal only runs on the client
  React.useEffect(() => {
    setMounted(true);
  }, []);

  const hide = React.useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setSelection({ rect: null, text: "" });
    setMode("actions");
    setAnswer("");
    setQuestionInput("");
    setStreaming(false);
  }, []);

  // Capture selection inside the container
  React.useEffect(() => {
    if (!mounted) return;

    const handleSelectionChange = () => {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (!sel || sel.rangeCount === 0) return;

      // If the selection collapsed (user clicked elsewhere), hide
      if (sel.isCollapsed) {
        // Don't immediately hide on simple clicks while a panel is open
        // because clicks inside the popover collapse the selection.
        const active = document.activeElement;
        if (active && popoverRef.current?.contains(active)) return;
        if (popoverRef.current && popoverRef.current.matches(":hover")) return;
        setSelection({ rect: null, text: "" });
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      const range = sel.getRangeAt(0);

      // Ensure both ends of the selection are inside the container
      const startNode = range.startContainer;
      const endNode = range.endContainer;
      if (!container.contains(startNode) || !container.contains(endNode)) {
        return;
      }

      const text = sel.toString().trim();
      if (!text) {
        setSelection({ rect: null, text: "" });
        return;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      setSelection({ rect, text });
      // When a fresh selection appears, return to action chooser
      setMode("actions");
      setAnswer("");
      setQuestionInput("");
    };

    // Use mouseup as the primary trigger so the user has finalized
    // their drag-selection; fall back to selectionchange for keyboard
    // text-selection (shift+arrow).
    const onMouseUp = () => {
      // Defer to next tick so document.getSelection returns the final state
      window.setTimeout(handleSelectionChange, 0);
    };
    const onSelectionChange = () => {
      // Cheap: only react if there's actually a selection
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      handleSelectionChange();
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [containerRef, mounted]);

  // Esc + outside click
  React.useEffect(() => {
    if (!mounted) return;
    if (!selection.text) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      // If the click landed inside the transcript container AND there's
      // still a non-empty selection, leave us alone — selectionchange
      // will reposition. Otherwise dismiss.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      hide();
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [mounted, selection.text, hide]);

  // Abort any in-flight stream on unmount
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const runLookup = React.useCallback(
    async (opts: { question?: string }) => {
      if (!selection.text) return;
      // Reset any prior stream
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setAnswer("");
      setStreaming(true);

      try {
        const resp = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            text: selection.text,
            question: opts.question,
            sourceLanguage,
            targetLanguage,
          }),
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`Lookup failed: ${resp.status} ${resp.statusText}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              try {
                const evt = JSON.parse(data) as {
                  type: string;
                  value?: string;
                  message?: string;
                };
                if (evt.type === "text" && typeof evt.value === "string") {
                  setAnswer((prev) => prev + evt.value);
                } else if (evt.type === "error") {
                  throw new Error(evt.message ?? "Lookup error");
                }
              } catch {
                // ignore malformed frame
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Lookup failed";
        toast.error(msg);
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [selection.text, sourceLanguage, targetLanguage]
  );

  const onLookup = React.useCallback(() => {
    setMode("lookup");
    void runLookup({});
  }, [runLookup]);

  const onAskOpen = React.useCallback(() => {
    setMode("ask");
    setAnswer("");
  }, []);

  const onAskSubmit = React.useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!questionInput.trim()) return;
      void runLookup({ question: questionInput.trim() });
    },
    [questionInput, runLookup]
  );

  const onCopy = React.useCallback(async () => {
    if (!selection.text) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      toast.success("已复制");
      hide();
    } catch {
      toast.error("复制失败");
    }
  }, [selection.text, hide]);

  const onAddFlashcard = React.useCallback(async () => {
    if (!selection.text) return;
    setSavingFlashcard(true);
    try {
      // First generate a back (definition) via lookup (non-streamed accumulate)
      let back = "";
      const resp = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: selection.text,
          sourceLanguage,
          targetLanguage,
        }),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`生成释义失败: ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const evt = JSON.parse(data) as { type: string; value?: string };
              if (evt.type === "text" && typeof evt.value === "string") {
                back += evt.value;
              }
            } catch {
              // ignore
            }
          }
        }
      }
      const trimmedBack = back.trim() || "(暂无释义)";

      const createResp = await fetch("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          front: selection.text,
          back: trimmedBack,
          sourceSessionId: sessionId,
        }),
      });
      if (!createResp.ok) {
        throw new Error(`保存生词失败: ${createResp.status}`);
      }
      toast.success("已加入生词本");
      hide();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加入生词本失败";
      toast.error(msg);
    } finally {
      setSavingFlashcard(false);
    }
  }, [selection.text, sourceLanguage, targetLanguage, sessionId, hide]);

  if (!mounted || !selection.rect || !selection.text) return null;

  // Position the popover above the selection if there's room, else below.
  const rect = selection.rect;
  const viewportHeight =
    typeof window !== "undefined" ? window.innerHeight : 800;
  const viewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 1200;
  const placeAbove = rect.top > viewportHeight - rect.bottom;
  const top = placeAbove
    ? Math.max(8, rect.top - POPOVER_OFFSET)
    : Math.min(viewportHeight - 8, rect.bottom + POPOVER_OFFSET);

  // Center horizontally on the selection, clamped to the viewport
  const desiredLeft = rect.left + rect.width / 2;
  const left = Math.min(
    Math.max(8 + POPOVER_WIDTH / 2, desiredLeft),
    viewportWidth - 8 - POPOVER_WIDTH / 2
  );

  const positionStyle: React.CSSProperties = {
    position: "fixed",
    top,
    left,
    transform: placeAbove
      ? "translate(-50%, -100%)"
      : "translate(-50%, 0%)",
    zIndex: 9999,
    width: mode === "actions" ? undefined : POPOVER_WIDTH,
    maxWidth: "calc(100vw - 16px)",
  };

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="选区操作"
      style={positionStyle}
      // Prevent the popover from stealing focus and collapsing the selection
      // when the user clicks on it.
      onMouseDown={(e) => {
        if (
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        ) {
          return;
        }
        e.preventDefault();
      }}
      className="rounded-lg border border-zinc-200 bg-white shadow-lg ring-1 ring-black/5 dark:border-zinc-800 dark:bg-zinc-950"
    >
      {mode === "actions" ? (
        <div className="flex items-center gap-1 px-1.5 py-1">
          <PopoverAction
            icon={<BookOpenText className="h-4 w-4" />}
            label="查词"
            onClick={onLookup}
          />
          <PopoverAction
            icon={<MessageCircleQuestion className="h-4 w-4" />}
            label="提问"
            onClick={onAskOpen}
          />
          <PopoverAction
            icon={<PlusCircle className="h-4 w-4" />}
            label="加生词本"
            onClick={onAddFlashcard}
            disabled={savingFlashcard}
          />
          <PopoverAction
            icon={<Copy className="h-4 w-4" />}
            label="复制"
            onClick={onCopy}
          />
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-1.5 text-xs dark:border-zinc-800">
            <span className="truncate text-zinc-500 dark:text-zinc-400">
              {mode === "ask" ? "针对这句话提问 LecSync" : "查词释义"}
            </span>
            <button
              type="button"
              onClick={hide}
              aria-label="关闭"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto px-3 py-2">
            <p className="mb-2 line-clamp-2 rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
              {selection.text}
            </p>

            {mode === "ask" ? (
              <form onSubmit={onAskSubmit} className="mb-2 flex gap-2">
                <input
                  autoFocus
                  value={questionInput}
                  onChange={(e) => setQuestionInput(e.target.value)}
                  placeholder="针对这句话提问 LecSync..."
                  className="flex h-8 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={streaming || !questionInput.trim()}
                >
                  {streaming ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "发送"
                  )}
                </Button>
              </form>
            ) : null}

            <div
              className={cn(
                "whitespace-pre-wrap text-sm leading-relaxed text-zinc-900 dark:text-zinc-100",
                !answer && streaming
                  ? "flex items-center gap-2 text-zinc-500"
                  : ""
              )}
              aria-live="polite"
            >
              {answer || (streaming ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在生成...
                </>
              ) : mode === "ask" ? (
                <span className="text-zinc-400">输入问题并回车 →</span>
              ) : null)}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}

interface PopoverActionProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function PopoverAction({ icon, label, onClick, disabled }: PopoverActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export default SelectionPopover;
