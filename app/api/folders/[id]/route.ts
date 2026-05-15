import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFolderDTO } from "@/lib/api/dto";

const langSchema = z.string().min(2).max(16);

const updateBodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    color: z.string().max(32).nullish(),
    sourceLang: langSchema.nullish(),
    targetLang: langSchema.nullish(),
  })
  .strict();

async function loadOwnedFolder(id: string, userId: string) {
  const row = await prisma.folder.findUnique({
    where: { id },
    include: { _count: { select: { sessions: true, documents: true } } },
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
  const row = await loadOwnedFolder(id, userId);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(
    toFolderDTO(row, {
      sessionCount: row._count.sessions,
      documentCount: row._count.documents,
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

  const existing = await loadOwnedFolder(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.color !== undefined) data.color = parsed.data.color;
  if (parsed.data.sourceLang !== undefined) data.sourceLang = parsed.data.sourceLang;
  if (parsed.data.targetLang !== undefined) data.targetLang = parsed.data.targetLang;

  const updated = await prisma.folder.update({
    where: { id },
    data,
    include: { _count: { select: { sessions: true, documents: true } } },
  });

  return NextResponse.json(
    toFolderDTO(updated, {
      sessionCount: updated._count.sessions,
      documentCount: updated._count.documents,
    })
  );
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await ctx.params;
  const existing = await loadOwnedFolder(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.folder.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
