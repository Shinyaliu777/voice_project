import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import type { AudioStatusResponse } from "@/lib/contracts";

export async function GET(req: NextRequest) {
  const userId = await getDevUserId();
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true, status: true },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const agg = await prisma.audioChunk.aggregate({
    where: { sessionId },
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });

  let state: AudioStatusResponse["state"];
  switch (session.status) {
    case "ready":
      state = "finalized";
      break;
    case "error":
      state = "error";
      break;
    default:
      state = "in_progress";
  }

  const resp: AudioStatusResponse = {
    sessionId,
    uploadedChunks: agg._count._all,
    totalBytes: agg._sum.sizeBytes ?? 0,
    state,
  };
  return NextResponse.json(resp);
}
