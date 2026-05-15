import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFlashcardDTO } from "@/lib/api/dto";

export async function GET(req: Request) {
  const userId = await getDevUserId();
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = (() => {
    const n = limitParam ? parseInt(limitParam, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(200, n);
  })();

  const now = new Date();
  const where = { userId, nextReviewAt: { lte: now } };

  const [cards, dueCount] = await Promise.all([
    prisma.flashcard.findMany({
      where,
      orderBy: { nextReviewAt: "asc" },
      take: limit,
    }),
    prisma.flashcard.count({ where }),
  ]);

  return NextResponse.json({
    cards: cards.map(toFlashcardDTO),
    dueCount,
  });
}
