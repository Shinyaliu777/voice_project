import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFlashcardDTO } from "@/lib/api/dto";

const PatchBodySchema = z
  .object({
    front: z.string().min(1).optional(),
    back: z.string().min(1).optional(),
  })
  .refine(
    (v) => v.front !== undefined || v.back !== undefined,
    "front or back required"
  );

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await params;

  let body: z.infer<typeof PatchBodySchema>;
  try {
    const json = await req.json();
    body = PatchBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const existing = await prisma.flashcard.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Flashcard not found" },
      { status: 404 }
    );
  }

  const updated = await prisma.flashcard.update({
    where: { id },
    data: {
      ...(body.front !== undefined ? { front: body.front } : {}),
      ...(body.back !== undefined ? { back: body.back } : {}),
    },
  });

  return NextResponse.json(toFlashcardDTO(updated));
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await params;

  const existing = await prisma.flashcard.findFirst({
    where: { id, userId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json(
      { error: "Flashcard not found" },
      { status: 404 }
    );
  }

  await prisma.flashcard.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
