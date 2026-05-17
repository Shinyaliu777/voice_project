"use client";

import * as React from "react";
import { ChevronLeft, Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { FlashcardDTO } from "@/lib/contracts";

export interface FlashcardDeckProps {
  cards: FlashcardDTO[];
  /** Called after the user grades the final card. */
  onFinished?: () => void;
  /** Called after each successful review. */
  onReviewed?: (cardId: string, rating: number) => void;
  className?: string;
}

const RATING_LABELS: Record<number, string> = {
  0: "完全忘记",
  1: "几乎不记得",
  2: "勉强想起",
  3: "正确",
  4: "熟悉",
  5: "非常熟悉",
};

export function FlashcardDeck({
  cards,
  onFinished,
  onReviewed,
  className,
}: FlashcardDeckProps) {
  const [index, setIndex] = React.useState(0);
  const [revealed, setRevealed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset state if the deck changes.
  React.useEffect(() => {
    setIndex(0);
    setRevealed(false);
  }, [cards]);

  if (!cards || cards.length === 0) {
    return (
      <div
        className={cn(
          "rounded-lg border border-dashed border-zinc-200 px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400",
          className
        )}
      >
        今日没有需要复习的卡片。
      </div>
    );
  }

  if (index >= cards.length) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-3 rounded-lg border border-zinc-200 p-8 text-center dark:border-zinc-800",
          className
        )}
      >
        <div className="text-2xl">🎉</div>
        <p className="text-sm font-medium">本轮复习完成！</p>
        <Button variant="outline" size="sm" onClick={() => setIndex(0)}>
          <ChevronLeft className="h-4 w-4" />
          再来一次
        </Button>
      </div>
    );
  }

  const card = cards[index];

  const submitRating = async (rating: 0 | 1 | 2 | 3 | 4 | 5) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const resp = await fetch(`/api/flashcards/${card.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating }),
      });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      onReviewed?.(card.id, rating);
      // Advance
      setRevealed(false);
      if (index + 1 >= cards.length) {
        setIndex(index + 1);
        onFinished?.();
      } else {
        setIndex(index + 1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "提交失败";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{`${index + 1} / ${cards.length}`}</span>
        <span>复习次数 {card.reviewCount}</span>
      </div>

      <Card className="min-h-[220px]">
        <CardContent className="flex min-h-[220px] flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="text-xl font-medium">{card.front}</div>
          {revealed ? (
            <div className="border-t border-zinc-200 pt-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
              {card.back}
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRevealed(true)}
            >
              <Eye className="h-4 w-4" />
              <span>显示答案</span>
            </Button>
          )}
        </CardContent>
      </Card>

      {revealed ? (
        <div className="grid grid-cols-3 gap-2">
          {[
            { rating: 1 as const, label: "重来", hint: "完全不记得，明天再练", tone: "destructive" as const },
            { rating: 3 as const, label: "良好", hint: "想了一下答对了", tone: "outline" as const },
            { rating: 5 as const, label: "简单", hint: "毫无难度", tone: "default" as const },
          ].map(({ rating, label, hint, tone }) => (
            <Button
              key={rating}
              variant={tone}
              size="sm"
              disabled={submitting}
              onClick={() => submitRating(rating)}
              title={`${label} — ${hint}`}
              className="flex h-auto flex-col items-center gap-0.5 py-2.5"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <span className="text-sm font-semibold">{label}</span>
                  <span className="text-[10px] font-normal opacity-70">{hint}</span>
                </>
              )}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setRevealed(true)}>
            <EyeOff className="h-4 w-4" />
            <span>点击查看答案后评分</span>
          </Button>
        </div>
      )}
    </div>
  );
}

export default FlashcardDeck;
