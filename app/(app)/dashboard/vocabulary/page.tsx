import Link from "next/link";
import { Sparkles } from "lucide-react";
import { FlashcardRecommendDialog } from "@/components/FlashcardRecommendDialog";
import { FlashcardDeck } from "@/components/FlashcardDeck";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import type { FlashcardDTO } from "@/lib/contracts";

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const sec = Math.max(1, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  const year = Math.floor(month / 12);
  return `${year} 年前`;
}

export default async function VocabularyPage() {
  const userId = await getDevUserId();
  const now = new Date();

  const [sourceSessions, dueCards] = await Promise.all([
    // Eligible source sessions: have at least one segment, status ready
    prisma.session.findMany({
      where: {
        userId,
        status: "ready",
        segments: { some: {} },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { _count: { select: { segments: true, flashcards: true } } },
    }),
    prisma.flashcard.findMany({
      where: { userId, nextReviewAt: { lte: now } },
      orderBy: { nextReviewAt: "asc" },
      take: 20,
    }),
  ]);

  const dueFlashcards: FlashcardDTO[] = dueCards.map((c) => ({
    id: c.id,
    front: c.front,
    back: c.back,
    sourceSessionId: c.sourceSessionId,
    sourceSegmentId: c.sourceSegmentId,
    intervalDays: c.intervalDays,
    easeFactor: c.easeFactor,
    reviewCount: c.reviewCount,
    nextReviewAt: c.nextReviewAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
  }));

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
          再也不漏掉听到的每一个生词
        </h1>
        <p className="mt-2 text-base text-zinc-500">
          从录音里提取生词，按艾宾浩斯曲线复习，让记忆扎根
        </p>
      </header>

      <Tabs defaultValue="vocabulary" className="mb-10 w-full">
        <TabsList>
          <TabsTrigger value="vocabulary" asChild>
            <Link href="/dashboard/vocabulary">词汇</Link>
          </TabsTrigger>
          <TabsTrigger value="flashcards" asChild>
            <Link href="/dashboard/vocabulary/flashcards">闪卡</Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <section className="mb-12">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-medium text-zinc-900">
          <Sparkles className="h-5 w-5 text-amber-500" />
          选一段录音开始
        </h2>
        {sourceSessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500">
            还没有可用的录音 — 完成一次录音后即可生成词卡
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sourceSessions.map((s) => (
              <div
                key={s.id}
                className="rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm"
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-zinc-900">
                      {s.title || "未命名录音"}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {formatRelative(s.createdAt)} · {s._count.segments} 段
                    </div>
                  </div>
                  <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600">
                    {s.sourceLang.toUpperCase()} →{" "}
                    {s.targetLang.toUpperCase()}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">
                    已生成 {s._count.flashcards} 张词卡
                  </span>
                  <FlashcardRecommendDialog sessionId={s.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-lg font-medium text-zinc-900">
          今日复习
          <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
            {dueFlashcards.length}
          </span>
        </h2>
        {dueFlashcards.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500">
            今日已无待复习的词卡 — 明天见！
          </div>
        ) : (
          <FlashcardDeck cards={dueFlashcards} />
        )}
      </section>
    </div>
  );
}
