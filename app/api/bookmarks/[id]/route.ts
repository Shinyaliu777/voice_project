import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toBookmarkDTO } from "@/lib/api/dto";

const updateBodySchema = z
  .object({
    atMs: z.number().int().min(0).optional(),
    note: z.string().max(2_000).nullish(),
  })
  .strict();

async function loadOwnedBookmark(id: string, userId: string) {
  const row = await prisma.bookmark.findUnique({
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
  const parsed = updateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await loadOwnedBookmark(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (parsed.data.atMs !== undefined) data.atMs = parsed.data.atMs;
  if (parsed.data.note !== undefined) data.note = parsed.data.note;

  const updated = await prisma.bookmark.update({ where: { id }, data });
  return NextResponse.json(toBookmarkDTO(updated));
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await ctx.params;
  const existing = await loadOwnedBookmark(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.bookmark.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
