import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * Returns the most recent "unfinished" recording session for this user,
 * if one exists — used by the dashboard landing page to prompt the user
 * with a "上次录音未结束" banner offering Resume / Finalize / Discard.
 *
 * "Unfinished" means status is one of recording / uploading / idle AND
 * the session has at least one uploaded audio chunk. We require chunks
 * because an idle session with no chunks is just a fresh draft from
 * clicking 新建录音 and immediately leaving — there's nothing to recover.
 *
 * Returns: { session: { id, title, createdAt, status, sourceLang,
 *           targetLang, chunkCount, segmentCount, lastChunkEndMs } } or
 *           { session: null } if nothing recoverable.
 *
 * The `lastChunkEndMs` is sum(AudioChunk.durationMs), which is the
 * recording's wall-clock duration so far — used in the banner copy
 * ("已录制 X 分钟，N 个音频块").
 */
export async function GET() {
  const userId = await getDevUserId();

  // Find the most recent session in an in-progress state, with at
  // least one audio chunk to recover.
  const session = await prisma.session.findFirst({
    where: {
      userId,
      status: { in: ["recording", "uploading", "idle"] },
      audioChunks: { some: {} },
    },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { audioChunks: true, segments: true } },
    },
  });

  if (!session) return NextResponse.json({ session: null });

  const chunkDurationAgg = await prisma.audioChunk.aggregate({
    where: { sessionId: session.id },
    _sum: { durationMs: true },
  });

  return NextResponse.json({
    session: {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      status: session.status,
      sourceLang: session.sourceLang,
      targetLang: session.targetLang,
      chunkCount: session._count.audioChunks,
      segmentCount: session._count.segments,
      lastChunkEndMs: chunkDurationAgg._sum.durationMs ?? 0,
    },
  });
}
