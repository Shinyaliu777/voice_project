import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFlashcardDTO } from "@/lib/api/dto";

const FlashcardReviewBodySchema = z.object({
  rating: z
    .number()
    .int()
    .min(0)
    .max(5)
    .transform((v) => v as 0 | 1 | 2 | 3 | 4 | 5),
});

const MIN_EF = 1.3;
const DAY_MS = 86_400_000;
const TEN_MIN_MS = 10 * 60 * 1000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await params;

  let body: z.infer<typeof FlashcardReviewBodySchema>;
  try {
    const json = await req.json();
    body = FlashcardReviewBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const card = await prisma.flashcard.findFirst({
    where: { id, userId },
  });
  if (!card) {
    return NextResponse.json(
      { error: "Flashcard not found" },
      { status: 404 }
    );
  }

  const rating = body.rating;
  const now = new Date();
  let intervalDays = card.intervalDays;
  let easeFactor = card.easeFactor;
  let reviewCount = card.reviewCount;
  let nextReviewAt: Date;

  if (rating <= 2) {
    reviewCount = 0;
    intervalDays = 0;
    easeFactor = Math.max(MIN_EF, easeFactor - 0.2);
    nextReviewAt = new Date(now.getTime() + TEN_MIN_MS);
  } else {
    const prevIntervalDays = intervalDays;
    reviewCount = reviewCount + 1;
    easeFactor = Math.max(
      MIN_EF,
      easeFactor +
        0.1 -
        (5 - rating) * (0.08 + (5 - rating) * 0.02)
    );
    if (reviewCount === 1) {
      intervalDays = 1;
    } else if (reviewCount === 2) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(prevIntervalDays * easeFactor);
    }
    nextReviewAt = new Date(now.getTime() + intervalDays * DAY_MS);
  }

  const [updated] = await prisma.$transaction([
    prisma.flashcard.update({
      where: { id },
      data: {
        intervalDays,
        easeFactor,
        reviewCount,
        nextReviewAt,
      },
    }),
    prisma.flashcardReview.create({
      data: {
        flashcardId: id,
        rating,
      },
    }),
  ]);

  return NextResponse.json(toFlashcardDTO(updated));
}
