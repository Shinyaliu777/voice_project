import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";
import { toSessionDTO } from "@/lib/api/dto";

export async function GET(req: Request) {
  const userId = await getDevUserId();
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = (() => {
    const n = limitParam ? parseInt(limitParam, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return 20;
    return Math.min(100, n);
  })();

  // Sessions that already have flashcards
  const withFlashcardsIds = await prisma.flashcard.findMany({
    where: { userId, sourceSessionId: { not: null } },
    select: { sourceSessionId: true },
    distinct: ["sourceSessionId"],
  });
  const usedIds = withFlashcardsIds
    .map((f) => f.sourceSessionId)
    .filter((x): x is string => !!x);

  const withFlashcardsSessions = usedIds.length
    ? await prisma.session.findMany({
        where: { userId, id: { in: usedIds } },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { segments: true } },
          minutes: { select: { id: true } },
        },
        take: limit,
      })
    : [];

  // Eligible: recent sessions with segmentCount >= 10 not yet in usedIds
  const allRecent = await prisma.session.findMany({
    where: {
      userId,
      ...(usedIds.length ? { id: { notIn: usedIds } } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { segments: true } },
      minutes: { select: { id: true } },
    },
    take: limit * 3,
  });
  const eligible = allRecent
    .filter((s) => s._count.segments >= 10)
    .slice(0, limit);

  const storage = getStorageProvider();
  const urlFor = (key: string | null) =>
    key ? storage.publicUrlFor(key) : null;

  const withFlashcards = withFlashcardsSessions.map((s) =>
    toSessionDTO(s, {
      segmentCount: s._count.segments,
      hasMinutes: !!s.minutes,
      audioUrl: urlFor(s.audioPath),
    })
  );
  const eligibleDTOs = eligible.map((s) =>
    toSessionDTO(s, {
      segmentCount: s._count.segments,
      hasMinutes: !!s.minutes,
      audioUrl: urlFor(s.audioPath),
    })
  );

  return NextResponse.json({
    withFlashcards,
    eligible: eligibleDTOs,
  });
}
