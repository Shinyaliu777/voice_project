import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toSessionDTO, toSegmentDTO } from "@/lib/api/dto";

const QuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(req: Request) {
  const userId = await getDevUserId();
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Bad query", details: parsed.error.format() },
      { status: 400 }
    );
  }
  const { q, limit = 20 } = parsed.data;

  const [titleHits, segmentHits] = await Promise.all([
    prisma.session.findMany({
      where: {
        userId,
        title: { contains: q, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { _count: { select: { segments: true } } },
    }),
    prisma.segment.findMany({
      where: {
        session: { userId },
        OR: [
          { sourceText: { contains: q, mode: "insensitive" } },
          { translatedText: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { session: { select: { id: true, title: true } } },
    }),
  ]);

  return NextResponse.json({
    sessions: titleHits.map((s) =>
      toSessionDTO(s, { segmentCount: s._count.segments, hasMinutes: false })
    ),
    segmentHits: segmentHits.map((s) => ({
      segment: toSegmentDTO(s),
      sessionTitle: s.session.title,
    })),
  });
}
