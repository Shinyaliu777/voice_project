import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toSegmentDTO } from "@/lib/api/dto";

const createSegmentSchema = z.object({
  segmentIndex: z.number().int().min(0),
  audioStartMs: z.number().int().min(0),
  audioEndMs: z.number().int().min(0),
  speakerId: z.number().int().nullish(),
  sourceText: z.string(),
  translatedText: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  isFinal: z.boolean().optional(),
});

const bulkSchema = z.object({
  segments: z.array(createSegmentSchema).min(1).max(500),
});

async function assertOwnedSession(id: string, userId: string) {
  const row = await prisma.session.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!row || row.userId !== userId) return null;
  return row;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await ctx.params;
  const owned = await assertOwnedSession(id, userId);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.segment.findMany({
    where: { sessionId: id },
    orderBy: { segmentIndex: "asc" },
  });
  return NextResponse.json({ items: rows.map(toSegmentDTO) });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: sessionId } = await ctx.params;

  const owned = await assertOwnedSession(sessionId, userId);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Upsert by (sessionId, segmentIndex) inside a transaction for idempotent
  // partial retries.
  const segments = parsed.data.segments;
  const upserted = await prisma.$transaction(
    segments.map((s) =>
      prisma.segment.upsert({
        where: {
          sessionId_segmentIndex: {
            sessionId,
            segmentIndex: s.segmentIndex,
          },
        },
        create: {
          sessionId,
          segmentIndex: s.segmentIndex,
          audioStartMs: s.audioStartMs,
          audioEndMs: s.audioEndMs,
          speakerId: s.speakerId ?? null,
          sourceText: s.sourceText,
          translatedText: s.translatedText ?? null,
          confidence: s.confidence ?? null,
          isFinal: s.isFinal ?? true,
        },
        update: {
          audioStartMs: s.audioStartMs,
          audioEndMs: s.audioEndMs,
          speakerId: s.speakerId ?? null,
          sourceText: s.sourceText,
          translatedText: s.translatedText ?? null,
          confidence: s.confidence ?? null,
          isFinal: s.isFinal ?? true,
        },
      })
    )
  );

  return NextResponse.json(
    { items: upserted.map(toSegmentDTO) },
    { status: 201 }
  );
}
