import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FlashcardList } from "@/components/FlashcardList";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFlashcardDTO } from "@/lib/api/dto";
import type { FlashcardDTO } from "@/lib/contracts";

export default async function VocabularyFlashcardsPage() {
  const userId = await getDevUserId();
  const now = new Date();

  const [allCards, dueCount] = await Promise.all([
    prisma.flashcard.findMany({
      where: { userId },
      orderBy: [{ nextReviewAt: "asc" }, { createdAt: "desc" }],
    }),
    prisma.flashcard.count({
      where: { userId, nextReviewAt: { lte: now } },
    }),
  ]);

  const cards: FlashcardDTO[] = allCards.map(toFlashcardDTO);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6">
        <Link
          href="/dashboard/vocabulary"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
        >
          <ArrowLeft className="h-4 w-4" />
          返回词汇本
        </Link>
      </div>

      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
          闪卡
        </h1>
        <p className="mt-2 text-base text-zinc-500">
          基于 SM-2 间隔重复算法，每张闪卡按你的记忆曲线安排下一次复习
        </p>
      </header>

      <Tabs defaultValue="flashcards" className="mb-6 w-full">
        <TabsList>
          <TabsTrigger value="vocabulary" asChild>
            <Link href="/dashboard/vocabulary">词汇</Link>
          </TabsTrigger>
          <TabsTrigger value="flashcards" asChild>
            <Link href="/dashboard/vocabulary/flashcards">闪卡</Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <FlashcardList initialCards={cards} initialDueCount={dueCount} />
    </div>
  );
}
