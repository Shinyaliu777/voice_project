"use client";

import * as React from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type {
  CreateFlashcardBody,
  FlashcardRecommendBody,
  FlashcardRecommendResponse,
} from "@/lib/contracts";

type Candidate = FlashcardRecommendResponse["candidates"][number];

export interface RecommendCardsDialogProps {
  sessionId: string;
  /** Max number of candidates to request from the LLM. Defaults to 8. */
  maxCards?: number;
  /** Optional override for the trigger button label. */
  triggerLabel?: string;
  /** Called after candidates are successfully added. */
  onAdded?: (count: number) => void;
}

/**
 * Triggered from the session detail page — POSTs to /api/flashcards/recommend
 * to load LLM-suggested cards, then POSTs each selected candidate to
 * /api/flashcards to persist it. The dialog is self-contained: it renders its
 * own trigger button.
 */
export function RecommendCardsDialog({
  sessionId,
  maxCards = 8,
  triggerLabel = "从此录音生成闪卡",
  onAdded,
}: RecommendCardsDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setCandidates([]);
    setChecked(new Set());
    setError(null);

    (async () => {
      try {
        const body: FlashcardRecommendBody = {
          sourceSessionId: sessionId,
          maxCards,
        };
        const resp = await fetch("/api/flashcards/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const data = (await resp.json()) as FlashcardRecommendResponse;
        if (!alive) return;
        const list = data.candidates ?? [];
        setCandidates(list);
        // All checked by default
        setChecked(new Set(list.map((_, idx) => idx)));
      } catch (err) {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : "加载推荐失败";
        setError(msg);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [open, sessionId, maxCards]);

  const toggle = (idx: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAll = () => {
    setChecked(new Set(candidates.map((_, i) => i)));
  };

  const clearAll = () => {
    setChecked(new Set());
  };

  const addSelected = async () => {
    const items = Array.from(checked)
      .map((i) => candidates[i])
      .filter((c): c is Candidate => Boolean(c));
    if (items.length === 0) {
      toast.error("请先选择至少一张卡片");
      return;
    }
    setSaving(true);
    let added = 0;
    let failed = 0;
    for (const cand of items) {
      const body: CreateFlashcardBody = {
        front: cand.front,
        back: cand.back,
        sourceSessionId: sessionId,
        sourceSegmentId: cand.sourceSegmentId,
      };
      try {
        const resp = await fetch("/api/flashcards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (resp.ok) added += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    setSaving(false);
    if (added > 0) {
      toast.success(
        `已加入 ${added} 张闪卡${failed > 0 ? `，${failed} 张失败` : ""}`
      );
      onAdded?.(added);
      setOpen(false);
    } else {
      toast.error("加入闪卡失败");
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="h-4 w-4" />
        <span>{triggerLabel}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (saving) return;
          setOpen(v);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              从此录音生成闪卡
            </DialogTitle>
            <DialogDescription>
              AI 会从转录内容里挑选可能值得记忆的生词或要点，确认后即可加入闪卡库。
            </DialogDescription>
          </DialogHeader>

          {!loading && candidates.length > 0 ? (
            <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
              <span>
                选中 <span className="font-mono">{checked.size}</span> /{" "}
                <span className="font-mono">{candidates.length}</span>
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  onClick={selectAll}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  onClick={clearAll}
                >
                  全不选
                </button>
              </div>
            </div>
          ) : null}

          <ScrollArea className="max-h-[55vh]">
            {loading ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>正在生成候选词卡…</span>
              </div>
            ) : error ? (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                {error}
              </div>
            ) : candidates.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-500">
                没有可推荐的词卡 — 这段录音可能内容太短，或不含生词
              </p>
            ) : (
              <ul className="flex flex-col gap-2 pr-2">
                {candidates.map((c, idx) => {
                  const on = checked.has(idx);
                  return (
                    <li key={`${c.front}-${idx}`}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors",
                          on
                            ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                            : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(idx)}
                          className="mt-0.5 h-4 w-4 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">
                            {c.front}
                          </div>
                          <div className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                            {c.back}
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button
              onClick={addSelected}
              disabled={saving || loading || checked.size === 0}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              <span>加入闪卡</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default RecommendCardsDialog;
