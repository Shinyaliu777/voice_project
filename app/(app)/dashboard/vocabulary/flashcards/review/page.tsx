import { FlashcardReview } from "@/components/FlashcardReview";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFlashcardDTO } from "@/lib/api/dto";
import type { FlashcardDTO } from "@/lib/contracts";

export const dynamic = "force-dynamic";

export default async function VocabularyFlashcardsReviewPage() {
  const userId = await getDevUserId();
  const now = new Date();

  const dueRows = await prisma.flashcard.findMany({
    where: { userId, nextReviewAt: { lte: now } },
    orderBy: { nextReviewAt: "asc" },
    take: 200,
  });

  const cards: FlashcardDTO[] = dueRows.map(toFlashcardDTO);

  return (
    <div className="mx-auto max-w-full px-3 py-6 sm:max-w-3xl sm:px-4 md:px-6 md:py-8 lg:px-8 lg:py-10">
      <header className="mb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          闪卡复习
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          看正面回忆答案，翻面后按记忆程度评分（0–5），SM-2 会自动安排下一次
        </p>
      </header>

      <FlashcardReview initialCards={cards} />
    </div>
  );
}
