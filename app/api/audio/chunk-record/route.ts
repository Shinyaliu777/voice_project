import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

const bodySchema = z.object({
  sessionId: z.string().min(1),
  chunkIndex: z.number().int().min(0),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(0),
  durationSeconds: z.number().min(0),
  publicUrl: z.string().min(1),
  storageKey: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const data = parsed.data;

  const session = await prisma.session.findUnique({
    where: { id: data.sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.audioChunk.upsert({
    where: {
      sessionId_chunkIndex: {
        sessionId: data.sessionId,
        chunkIndex: data.chunkIndex,
      },
    },
    create: {
      sessionId: data.sessionId,
      chunkIndex: data.chunkIndex,
      sizeBytes: data.sizeBytes,
      durationMs: Math.round(data.durationSeconds * 1000),
      contentType: data.contentType,
      storageKey: data.storageKey,
      publicUrl: data.publicUrl,
    },
    update: {
      sizeBytes: data.sizeBytes,
      durationMs: Math.round(data.durationSeconds * 1000),
      contentType: data.contentType,
      storageKey: data.storageKey,
      publicUrl: data.publicUrl,
    },
  });

  return NextResponse.json({ ok: true });
}
