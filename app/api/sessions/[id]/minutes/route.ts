import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toMinutesDTO } from "@/lib/api/dto";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: sessionId } = await params;

  // Scope: ensure session belongs to dev user
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const minutes = await prisma.minutes.findUnique({
    where: { sessionId },
  });
  if (!minutes) {
    return NextResponse.json({ error: "Minutes not found" }, { status: 404 });
  }

  return NextResponse.json(toMinutesDTO(minutes));
}
