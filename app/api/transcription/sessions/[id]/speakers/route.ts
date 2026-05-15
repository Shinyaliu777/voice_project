import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toSpeakerNameDTO } from "@/lib/api/dto";

const upsertSchema = z.object({
  speakerId: z.number().int().min(0),
  name: z.string().min(1).max(120),
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

  const rows = await prisma.speakerName.findMany({
    where: { sessionId: id },
    orderBy: { speakerId: "asc" },
  });
  return NextResponse.json({ items: rows.map(toSpeakerNameDTO) });
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
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { speakerId, name } = parsed.data;

  const row = await prisma.speakerName.upsert({
    where: { sessionId_speakerId: { sessionId, speakerId } },
    create: { sessionId, speakerId, name },
    update: { name },
  });

  return NextResponse.json(toSpeakerNameDTO(row));
}
