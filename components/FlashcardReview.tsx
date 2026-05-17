"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  FlashcardDTO,
  FlashcardReviewBody,
} from "@/lib/contracts";

export interface FlashcardReviewProps {
  initialCards: FlashcardDTO[];
  className?: string;
}

const RATING_BUTTONS: Array<{
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  label: string;
  tone: "destructive" | "outline" | "secondary" | "default";
  hint: string;
}> = [
  { rating: 0, label: "完全忘记", tone: "destructive", hint: "彻底没印象" },
  { rating: 1, label: "错误", tone: "destructive", hint: "想错了" },
  { rating: 2, label: "困难", tone: "outline", hint: "几乎答不上来" },
  { rating: 3, label: "一般", tone: "outline", hint: "犹豫后想起" },
  { rating: 4, label: "容易", tone: "secondary", hint: "顺利想起" },
  { rating: 5, label: "完美", tone: "default", hint: "脱口而出" },
];

interface ReviewLogEntry {
  cardId: string;
  rating: number;
}

export function FlashcardReview({ initialCards, className }: FlashcardReviewProps) {
  const totalCount = initialCards.length;
  const [queue] = React.useState<FlashcardDTO[]>(initialCards);
  const [index, setIndex] = React.useState(0);
  const [revealed, setRevealed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [log, setLog] = React.useState<ReviewLogEntry[]>([]);

  const card = queue[index];
  const done = !card;

  React.useEffect(() => {
    // reset reveal when index moves forward
    setRevealed(false);
  }, [index]);

  // Keyboard shortcuts: space to flip, 0..5 to rate, ←/→ to skip when revealed
  React.useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.code === "Space") {
        e.preventDefault();
        setRevealed((v) => !v);
        return;
      }
      if (!revealed) return;
      const n = parseInt(e.key, 10);
      if (Number.isInteger(n) && n >= 0 && n <= 5) {
        e.preventDefault();
        void submitRating(n as 0 | 1 | 2 | 3 | 4 | 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, submitting, done, card?.id]);

  const submitRating = async (rating: 0 | 1 | 2 | 3 | 4 | 5) => {
    if (!card || submitting) return;
    setSubmitting(true);
    try {
      const body: FlashcardReviewBody = { rating };
      const resp = await fetch(`/api/flashcards/${card.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      setLog((prev) => [...prev, { cardId: card.id, rating }]);
      setIndex((i) => i + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "提交失败";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setIndex(0);
    setRevealed(false);
    setLog([]);
  };

  if (totalCount === 0) {
    return (
      <div
        className={cn(
          "mx-auto flex max-w-xl flex-col items-center gap-4 rounded-xl border border-dashed border-zinc-200 bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-950",
          className
        )}
      >
        <Sparkles className="h-8 w-8 text-amber-500" />
        <div className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
          今日已经全部复习完成
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          没有需要复习的卡片 — 明天再回来吧
        </p>
        <Button variant="outline" asChild>
          <Link href="/dashboard/vocabulary/flashcards">
            <ArrowLeft className="h-4 w-4" />
            返回闪卡列表
          </Link>
        </Button>
      </div>
    );
  }

  if (done) {
    const avg =
      log.length > 0
        ? log.reduce((acc, l) => acc + l.rating, 0) / log.length
        : 0;
    return (
      <div
        className={cn(
          "mx-auto flex max-w-xl flex-col items-center gap-5 rounded-xl border border-zinc-200 bg-white p-12 text-center dark:border-zinc-800 dark:bg-zinc-950",
          className
        )}
      >
        <div className="text-4xl">🎉</div>
        <div>
          <div className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
            今天复习了 {log.length} 张
          </div>
          <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            平均评分 {avg.toFixed(1)} / 5
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={restart} disabled={queue.length === 0}>
            <RotateCcw className="h-4 w-4" />
            再来一遍
          </Button>
          <Button asChild>
            <Link href="/dashboard/vocabulary/flashcards">继续</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-2xl flex-col items-stretch gap-6",
        className
      )}
    >
      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <Link
          href="/dashboard/vocabulary/flashcards"
          className="inline-flex items-center gap-1 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </Link>
        <span className="font-mono">
          {index + 1} / {totalCount}
        </span>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
        <div
          className="h-full bg-zinc-900 transition-all duration-300 dark:bg-zinc-100"
          style={{
            width: `${Math.min(100, (index / Math.max(1, totalCount)) * 100)}%`,
          }}
        />
      </div>

      <Card className="min-h-[320px]">
        <CardContent
          className="flex min-h-[320px] cursor-pointer flex-col items-center justify-center gap-6 p-8 text-center"
          onClick={() => setRevealed((v) => !v)}
        >
          <div className="text-3xl font-medium leading-snug text-zinc-900 dark:text-zinc-100 sm:text-4xl">
            {card.front}
          </div>
          {revealed ? (
            <div className="w-full border-t border-zinc-200 pt-5 text-base leading-relaxed text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
              {card.back}
            </div>
          ) : (
            <div className="text-xs text-zinc-400 dark:text-zinc-500">
              点击卡片或按空格键查看答案
            </div>
          )}
        </CardContent>
      </Card>

      {revealed ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {RATING_BUTTONS.map((b) => (
            <Button
              key={b.rating}
              variant={b.tone}
              size="sm"
              disabled={submitting}
              onClick={() => submitRating(b.rating)}
              title={b.hint}
              className="flex h-auto flex-col items-center gap-0.5 py-3"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <span className="text-sm font-semibold">
                    <span className="mr-1 font-mono opacity-70">{b.rating}</span>
                    {b.label}
                  </span>
                  <span className="text-[10px] font-normal opacity-70">
                    {b.hint}
                  </span>
                </>
              )}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => setRevealed(true)}
            disabled={submitting}
          >
            显示答案
          </Button>
        </div>
      )}
    </div>
  );
}

export default FlashcardReview;
