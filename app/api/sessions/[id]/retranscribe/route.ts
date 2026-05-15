import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: sessionId } = await params;

  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Cascade should handle most of this, but we explicitly clear segments and
  // minutes so the UI returns to a fresh recording state.
  await prisma.$transaction([
    prisma.segment.deleteMany({ where: { sessionId } }),
    prisma.minutes.deleteMany({ where: { sessionId } }),
    prisma.session.update({
      where: { id: sessionId },
      data: { status: "recording" },
    }),
  ]);

  return NextResponse.json(
    {
      ok: true,
      note: "Phase 1 stub — ASR re-run from audioPath is Phase 2 follow-up",
    },
    { status: 202 }
  );
}
