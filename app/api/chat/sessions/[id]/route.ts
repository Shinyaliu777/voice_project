import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toChatMessageDTO, toChatSessionDTO } from "@/lib/api/dto";

const PatchBodySchema = z.object({
  title: z.string().min(1).optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await params;

  const row = await prisma.chatSession.findFirst({
    where: { id, userId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      _count: { select: { messages: true } },
    },
  });
  if (!row) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }
  return NextResponse.json({
    session: toChatSessionDTO(row, { messageCount: row._count.messages }),
    messages: row.messages.map(toChatMessageDTO),
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await params;

  let body: z.infer<typeof PatchBodySchema>;
  try {
    const json = await req.json().catch(() => ({}));
    body = PatchBodySchema.parse(json ?? {});
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const existing = await prisma.chatSession.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  const updated = await prisma.chatSession.update({
    where: { id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
    },
    include: { _count: { select: { messages: true } } },
  });
  return NextResponse.json(
    toChatSessionDTO(updated, { messageCount: updated._count.messages })
  );
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await params;

  const existing = await prisma.chatSession.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  await prisma.chatSession.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
