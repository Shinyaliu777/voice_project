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
  FlashcardRecommendResponse,
} from "@/lib/contracts";

type Candidate = FlashcardRecommendResponse["candidates"][number];

export interface FlashcardRecommendDialogProps {
  sessionId: string;
  /** Controlled open state. Omit (with onOpenChange) to render a built-in trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called after cards are successfully added */
  onAdded?: (count: number) => void;
  /** Label of the auto-rendered trigger button when uncontrolled. */
  triggerLabel?: string;
}

export function FlashcardRecommendDialog({
  sessionId,
  open: openProp,
  onOpenChange,
  onAdded,
  triggerLabel,
}: FlashcardRecommendDialogProps) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = isControlled ? !!openProp : internalOpen;
  const setOpen = React.useCallback(
    (v: boolean) => {
      if (isControlled) onOpenChange?.(v);
      else setInternalOpen(v);
    },
    [isControlled, onOpenChange]
  );

  const [loading, setLoading] = React.useState(false);
  const [candidates, setCandidates] = React.useState<Candidate[]>([]);
  const [checked, setChecked] = React.useState<Set<number>>(new Set());
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setCandidates([]);
    setChecked(new Set());
    (async () => {
      try {
        const resp = await fetch("/api/flashcards/recommend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceSessionId: sessionId }),
        });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const data = (await resp.json()) as FlashcardRecommendResponse;
        if (alive) {
          setCandidates(data.candidates ?? []);
          setChecked(new Set((data.candidates ?? []).map((_, i) => i)));
        }
      } catch (err) {
        if (alive) {
          const msg = err instanceof Error ? err.message : "加载推荐失败";
          toast.error(msg);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, sessionId]);

  const toggle = (idx: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const addSelected = async () => {
    const items = Array.from(checked)
      .map((i) => candidates[i])
      .filter(Boolean);
    if (items.length === 0) {
      toast.error("请先选择卡片");
      return;
    }
    setSaving(true);
    let added = 0;
    let failed = 0;
    for (const card of items) {
      const body: CreateFlashcardBody = {
        front: card.front,
        back: card.back,
        sourceSessionId: sessionId,
        sourceSegmentId: card.sourceSegmentId,
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
      toast.success(`已添加 ${added} 张卡片${failed > 0 ? `，失败 ${failed}` : ""}`);
      onAdded?.(added);
      setOpen(false);
    } else {
      toast.error("添加失败");
    }
  };

  return (
    <>
      {!isControlled && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Sparkles className="h-4 w-4" />
          <span>{triggerLabel ?? "生成"}</span>
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" /> 推荐生词卡
            </DialogTitle>
            <DialogDescription>
              从本次会议中智能挑选可能的生词，选择需要加入词汇本的卡片。
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[50vh]">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              </div>
            ) : candidates.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">没有可推荐的生词。</p>
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
                          className="mt-0.5 h-4 w-4"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{c.front}</div>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
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
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={addSelected} disabled={saving || loading || checked.size === 0}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span>添加选中的卡片</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default FlashcardRecommendDialog;
