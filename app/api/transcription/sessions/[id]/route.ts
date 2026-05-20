import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toSessionDTO } from "@/lib/api/dto";
import { audioFileUrl } from "@/lib/audio-url";

const SESSION_STATUSES = [
  "idle",
  "recording",
  "uploading",
  "ready",
  "error",
] as const;

const updateBodySchema = z
  .object({
    title: z.string().max(200).optional(),
    folderId: z.string().nullish(),
    status: z.enum(SESSION_STATUSES).optional(),
    durationMs: z.number().int().min(0).optional(),
    audioPath: z.string().nullish(),
    audioContentType: z.string().nullish(),
  })
  .strict();

async function loadOwnedSession(id: string, userId: string) {
  const row = await prisma.session.findUnique({
    where: { id },
    include: {
      _count: { select: { segments: true } },
      minutes: { select: { id: true } },
    },
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
  const row = await loadOwnedSession(id, userId);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(
    toSessionDTO(row, {
      segmentCount: row._count.segments,
      hasMinutes: !!row.minutes,
      audioUrl: audioFileUrl(row.audioPath),
    })
  );
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
  const parsed = updateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await loadOwnedSession(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  const b = parsed.data;
  if (b.title !== undefined) data.title = b.title;
  if (b.folderId !== undefined) {
    if (b.folderId === null) {
      data.folderId = null;
    } else {
      const folder = await prisma.folder.findUnique({
        where: { id: b.folderId },
        select: { userId: true },
      });
      if (!folder || folder.userId !== userId) {
        return NextResponse.json({ error: "Folder not found" }, { status: 404 });
      }
      data.folderId = b.folderId;
    }
  }
  if (b.status !== undefined) data.status = b.status;
  if (b.durationMs !== undefined) data.durationMs = b.durationMs;
  if (b.audioPath !== undefined) data.audioPath = b.audioPath;
  if (b.audioContentType !== undefined) data.audioContentType = b.audioContentType;

  const updated = await prisma.session.update({
    where: { id },
    data,
    include: {
      _count: { select: { segments: true } },
      minutes: { select: { id: true } },
    },
  });

  return NextResponse.json(
    toSessionDTO(updated, {
      segmentCount: updated._count.segments,
      hasMinutes: !!updated.minutes,
      audioUrl: audioFileUrl(updated.audioPath),
    })
  );
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await ctx.params;
  const existing = await loadOwnedSession(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.session.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
