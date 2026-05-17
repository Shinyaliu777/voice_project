"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  CreateFlashcardBody,
  FlashcardDTO,
} from "@/lib/contracts";

export interface FlashcardListProps {
  initialCards: FlashcardDTO[];
  initialDueCount: number;
  className?: string;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString("zh-CN", {
      year: sameYear ? undefined : "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDueLabel(iso: string): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return formatDate(iso);
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "已到期";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} 分钟后`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时后`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天后`;
  return formatDate(iso);
}

interface CardFormState {
  front: string;
  back: string;
}

const EMPTY_FORM: CardFormState = { front: "", back: "" };

export function FlashcardList({
  initialCards,
  initialDueCount,
  className,
}: FlashcardListProps) {
  const [cards, setCards] = React.useState<FlashcardDTO[]>(initialCards);
  const [flipped, setFlipped] = React.useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<FlashcardDTO | null>(null);
  const [form, setForm] = React.useState<CardFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const dueCount = React.useMemo(() => {
    const now = Date.now();
    const fromList = cards.filter(
      (c) => new Date(c.nextReviewAt).getTime() <= now
    ).length;
    // initialDueCount comes from the server snapshot; once we mutate locally we
    // trust the recomputed count above.
    return Math.max(fromList, fromList === 0 ? 0 : initialDueCount);
  }, [cards, initialDueCount]);

  const toggleFlip = (id: string) => {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setCreateOpen(true);
  };

  const openEdit = (card: FlashcardDTO) => {
    setEditing(card);
    setForm({ front: card.front, back: card.back });
    setCreateOpen(true);
  };

  const submit = async () => {
    const front = form.front.trim();
    const back = form.back.trim();
    if (!front || !back) {
      toast.error("正面与背面均不能为空");
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        const resp = await fetch(`/api/flashcards/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ front, back }),
        });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const updated = (await resp.json()) as FlashcardDTO;
        setCards((prev) =>
          prev.map((c) => (c.id === updated.id ? updated : c))
        );
        toast.success("已更新");
      } else {
        const body: CreateFlashcardBody = { front, back };
        const resp = await fetch("/api/flashcards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const created = (await resp.json()) as FlashcardDTO;
        setCards((prev) => [created, ...prev]);
        toast.success("已新建闪卡");
      }
      setCreateOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存失败";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteCard = async (card: FlashcardDTO) => {
    if (deletingId) return;
    if (!confirm(`确认删除：「${card.front.slice(0, 40)}」？`)) return;
    setDeletingId(card.id);
    try {
      const resp = await fetch(`/api/flashcards/${card.id}`, {
        method: "DELETE",
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      toast.success("已删除");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "删除失败";
      toast.error(msg);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {dueCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/30">
          <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
            <Sparkles className="h-4 w-4" />
            <span>
              <span className="font-medium">{dueCount}</span> 张闪卡到期复习
            </span>
          </div>
          <Button size="sm" asChild>
            <Link href="/dashboard/vocabulary/flashcards/review">
              开始复习
            </Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          今天没有到期复习的卡片 — 继续保持！
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          全部闪卡
          <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {cards.length}
          </span>
        </h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          <span>新建闪卡</span>
        </Button>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          还没有闪卡 — 点击「新建闪卡」开始，或从录音页面智能推荐
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => {
            const isFlipped = flipped.has(card.id);
            return (
              <li key={card.id}>
                <div
                  className={cn(
                    "group flex h-full flex-col gap-3 rounded-xl border bg-white p-4 shadow-sm transition dark:bg-zinc-950",
                    isFlipped
                      ? "border-zinc-300 dark:border-zinc-700"
                      : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleFlip(card.id)}
                    className="flex flex-1 flex-col items-stretch gap-2 text-left"
                    aria-label={isFlipped ? "收起答案" : "查看答案"}
                  >
                    <div className="text-base font-medium leading-snug text-zinc-900 dark:text-zinc-100">
                      {card.front}
                    </div>
                    {isFlipped ? (
                      <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
                        {card.back}
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">
                        点击查看答案
                      </span>
                    )}
                  </button>
                  <div className="grid grid-cols-3 gap-2 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500 dark:border-zinc-900 dark:text-zinc-400">
                    <div title="下次复习时间">
                      <div className="text-zinc-400 dark:text-zinc-500">下次</div>
                      <div className="font-mono text-zinc-700 dark:text-zinc-300">
                        {formatDueLabel(card.nextReviewAt)}
                      </div>
                    </div>
                    <div title="复习次数">
                      <div className="text-zinc-400 dark:text-zinc-500">已复习</div>
                      <div className="font-mono text-zinc-700 dark:text-zinc-300">
                        {card.reviewCount} 次
                      </div>
                    </div>
                    <div title="SM-2 易度因子（越大越简单）">
                      <div className="text-zinc-400 dark:text-zinc-500">易度</div>
                      <div className="font-mono text-zinc-700 dark:text-zinc-300">
                        {card.easeFactor.toFixed(2)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(card)}
                      aria-label="编辑"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span>编辑</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteCard(card)}
                      disabled={deletingId === card.id}
                      aria-label="删除"
                    >
                      {deletingId === card.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      <span>删除</span>
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          if (!submitting) setCreateOpen(v);
          if (!v) {
            setEditing(null);
            setForm(EMPTY_FORM);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑闪卡" : "新建闪卡"}</DialogTitle>
            <DialogDescription>
              正面记录提问或生词，背面写答案或释义 — 复习时先看正面，回忆后翻面打分。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                正面
              </label>
              <Textarea
                rows={3}
                value={form.front}
                onChange={(e) =>
                  setForm((f) => ({ ...f, front: e.target.value }))
                }
                placeholder="例如：ubiquitous"
                disabled={submitting}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                背面
              </label>
              <Textarea
                rows={5}
                value={form.back}
                onChange={(e) =>
                  setForm((f) => ({ ...f, back: e.target.value }))
                }
                placeholder="例如：adj. 普遍存在的；无所不在的"
                disabled={submitting}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              <span>{editing ? "保存修改" : "添加闪卡"}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default FlashcardList;
