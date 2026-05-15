import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toSegmentDTO } from "@/lib/api/dto";

const updateSegmentSchema = z
  .object({
    sourceText: z.string().optional(),
    translatedText: z.string().nullish(),
    speakerId: z.number().int().nullish(),
  })
  .strict();

async function loadOwnedSegment(id: string, userId: string) {
  const row = await prisma.segment.findUnique({
    where: { id },
    include: { session: { select: { userId: true } } },
  });
  if (!row || row.session.userId !== userId) return null;
  return row;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = updateSegmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await loadOwnedSegment(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (parsed.data.sourceText !== undefined) data.sourceText = parsed.data.sourceText;
  if (parsed.data.translatedText !== undefined)
    data.translatedText = parsed.data.translatedText;
  if (parsed.data.speakerId !== undefined) data.speakerId = parsed.data.speakerId;

  const updated = await prisma.segment.update({ where: { id }, data });
  return NextResponse.json(toSegmentDTO(updated));
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await ctx.params;
  const existing = await loadOwnedSegment(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.segment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
