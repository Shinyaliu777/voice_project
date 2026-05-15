import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toChatSessionDTO } from "@/lib/api/dto";

const CreateChatSessionBodySchema = z
  .object({
    sessionId: z.string().optional(),
    title: z.string().optional(),
  })
  .default({});

export async function GET() {
  const userId = await getDevUserId();
  const rows = await prisma.chatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { messages: true } } },
  });
  const items = rows.map((r) =>
    toChatSessionDTO(r, { messageCount: r._count.messages })
  );
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const userId = await getDevUserId();

  let body: z.infer<typeof CreateChatSessionBodySchema>;
  try {
    const json = await req.json().catch(() => ({}));
    body = CreateChatSessionBodySchema.parse(json ?? {});
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  if (body.sessionId) {
    // scope: ensure recording session belongs to dev user
    const sess = await prisma.session.findFirst({
      where: { id: body.sessionId, userId },
      select: { id: true, title: true },
    });
    if (!sess) {
      return NextResponse.json(
        { error: "Source session not found" },
        { status: 404 }
      );
    }
  }

  const created = await prisma.chatSession.create({
    data: {
      userId,
      sessionId: body.sessionId ?? null,
      title: body.title?.trim() || "Untitled",
    },
    include: { _count: { select: { messages: true } } },
  });

  return NextResponse.json(
    toChatSessionDTO(created, { messageCount: created._count.messages }),
    { status: 201 }
  );
}
