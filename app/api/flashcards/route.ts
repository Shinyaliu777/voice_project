import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFlashcardDTO } from "@/lib/api/dto";

const CreateFlashcardBodySchema = z.object({
  front: z.string().min(1),
  back: z.string().min(1),
  sourceSessionId: z.string().optional(),
  sourceSegmentId: z.string().optional(),
});

export async function GET(req: Request) {
  const userId = await getDevUserId();
  const url = new URL(req.url);
  const dueOnly = url.searchParams.get("dueOnly");
  const filterDue = dueOnly === "1" || dueOnly === "true";

  const rows = await prisma.flashcard.findMany({
    where: {
      userId,
      ...(filterDue ? { nextReviewAt: { lte: new Date() } } : {}),
    },
    orderBy: { nextReviewAt: "asc" },
  });

  return NextResponse.json({ items: rows.map(toFlashcardDTO) });
}

export async function POST(req: Request) {
  const userId = await getDevUserId();

  let body: z.infer<typeof CreateFlashcardBodySchema>;
  try {
    const json = await req.json();
    body = CreateFlashcardBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  if (body.sourceSessionId) {
    const sess = await prisma.session.findFirst({
      where: { id: body.sourceSessionId, userId },
      select: { id: true },
    });
    if (!sess) {
      return NextResponse.json(
        { error: "Source session not found" },
        { status: 404 }
      );
    }
  }

  const created = await prisma.flashcard.create({
    data: {
      userId,
      front: body.front,
      back: body.back,
      sourceSessionId: body.sourceSessionId ?? null,
      sourceSegmentId: body.sourceSegmentId ?? null,
    },
  });

  return NextResponse.json(toFlashcardDTO(created), { status: 201 });
}
