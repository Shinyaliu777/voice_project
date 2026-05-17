import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toExtractedTermDTO } from "@/lib/api/dto";

const updateTermSchema = z
  .object({
    term: z.string().min(1).max(500).optional(),
    definition: z.string().max(4000).nullish(),
  })
  .strict();

async function loadOwnedTerm(id: string, userId: string) {
  const row = await prisma.extractedTerm.findUnique({
    where: { id },
    include: { document: { select: { folder: { select: { userId: true } } } } },
  });
  if (!row || row.document.folder.userId !== userId) return null;
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
  const parsed = updateTermSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await loadOwnedTerm(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (parsed.data.term !== undefined) data.term = parsed.data.term;
  if (parsed.data.definition !== undefined) data.definition = parsed.data.definition;

  const updated = await prisma.extractedTerm.update({ where: { id }, data });
  return NextResponse.json(toExtractedTermDTO(updated));
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await ctx.params;
  const existing = await loadOwnedTerm(id, userId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.extractedTerm.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
