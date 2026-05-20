import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId, UnauthenticatedError } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * Recording queue — slot allocation entry point.
 *
 * The client calls this once when the user clicks "开始录音". The server
 * either hands back an active slot (the client may proceed to open the
 * Soniox WS) or a queue position (the client polls /queue-status until
 * the slot promotes).
 *
 * Multi-tenant fairness: each user has a `maxConcurrentRecordings` cap.
 * Active slots count against the cap; queued slots wait FIFO via
 * `queuePosition`. When `release` is called the lowest-positioned queued
 * slot for that user is auto-promoted to active.
 *
 * Stale active slots: if the most recent Session attached to an active
 * slot hasn't been `updatedAt`'d in 10+ minutes we consider it dead
 * (browser tab closed, network died) and auto-release. The client gets
 * back `previousSessionEnded: true` so it can show a "上一个录音已自动
 * 结束" toast.
 *
 * Recovery: `recoverySessionId` (used by the dashboard's "恢复上次录音"
 * banner) reuses that Session row instead of creating a new one. The
 * Session must belong to the requesting user; otherwise we 403.
 *
 * Body schema:
 *   {
 *     translationSource?: "local" | "cloud" | string,
 *     folderId?: string | null,
 *     session: { sourceLanguage, targetLanguage },
 *     init?: bool,
 *     recoverySessionId?: string
 *   }
 *
 * Response:
 *   {
 *     allowed: bool,
 *     slotStatus: "ready" | "queued",
 *     queuePosition?: number,
 *     sessionId?: string,
 *     previousSessionEnded?: bool
 *   }
 */

const STALE_SLOT_MS = 10 * 60 * 1000; // 10 minutes

const startBodySchema = z.object({
  translationSource: z.string().optional(),
  folderId: z.string().nullish(),
  session: z.object({
    sourceLanguage: z.string().min(2).max(16),
    targetLanguage: z.string().min(2).max(16),
  }),
  init: z.boolean().optional(),
  recoverySessionId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await getDevUserId();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = startBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { folderId, session: sessionInfo, recoverySessionId } = parsed.data;

  // ----- Step 1: sweep stale active slots -----
  // We grab all active slots for this user, then look at the attached
  // Session.updatedAt. Anything older than 10min is dead — release the
  // slot and flag previousSessionEnded.
  const activeSlots = await prisma.recordingSlot.findMany({
    where: { userId, status: "active" },
    orderBy: { claimedAt: "asc" },
  });

  let previousSessionEnded = false;
  const liveSlotIds: string[] = [];
  if (activeSlots.length > 0) {
    const slotsWithSession = activeSlots.filter((s) => s.sessionId != null);
    const sessionIds = slotsWithSession.map((s) => s.sessionId as string);
    const sessions =
      sessionIds.length > 0
        ? await prisma.session.findMany({
            where: { id: { in: sessionIds } },
            select: { id: true, updatedAt: true },
          })
        : [];
    const sessionMap = new Map(sessions.map((s) => [s.id, s.updatedAt]));

    const cutoff = Date.now() - STALE_SLOT_MS;
    const staleSlotIds: string[] = [];
    for (const slot of activeSlots) {
      if (!slot.sessionId) {
        // Active slot without a session — odd, but treat as alive (claimedAt
        // is too recent to assume otherwise; the client just hasn't created
        // its Session yet). Fall through.
        liveSlotIds.push(slot.id);
        continue;
      }
      const updatedAt = sessionMap.get(slot.sessionId);
      if (!updatedAt || updatedAt.getTime() < cutoff) {
        staleSlotIds.push(slot.id);
      } else {
        liveSlotIds.push(slot.id);
      }
    }

    if (staleSlotIds.length > 0) {
      await prisma.recordingSlot.updateMany({
        where: { id: { in: staleSlotIds } },
        data: { status: "released", releasedAt: new Date() },
      });
      previousSessionEnded = true;
    }
  }

  // ----- Step 2: load cap + decide slot status -----
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { maxConcurrentRecordings: true },
  });
  const maxConcurrent = user?.maxConcurrentRecordings ?? 1;

  const activeCount = liveSlotIds.length;

  // Validate folder ownership early when one was supplied — same pattern
  // /api/transcription/sessions uses, so behavior stays consistent.
  if (folderId) {
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
      select: { userId: true },
    });
    if (!folder || folder.userId !== userId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
  }

  // Validate recoverySessionId ownership when supplied.
  let recoveredSession: { id: string } | null = null;
  if (recoverySessionId) {
    const found = await prisma.session.findUnique({
      where: { id: recoverySessionId },
      select: { id: true, userId: true },
    });
    if (!found || found.userId !== userId) {
      return NextResponse.json(
        { error: "Recovery session not found" },
        { status: 404 }
      );
    }
    recoveredSession = { id: found.id };
  }

  // ----- Step 3a: room available → create active slot + session -----
  if (activeCount < maxConcurrent) {
    let sessionId: string;
    if (recoveredSession) {
      sessionId = recoveredSession.id;
    } else {
      const created = await prisma.session.create({
        data: {
          userId,
          folderId: folderId ?? null,
          title: "",
          sourceLang: sessionInfo.sourceLanguage,
          targetLang: sessionInfo.targetLanguage,
          status: "recording",
        },
        select: { id: true },
      });
      sessionId = created.id;
    }

    await prisma.recordingSlot.create({
      data: {
        userId,
        sessionId,
        status: "active",
        queuePosition: null,
      },
    });

    return NextResponse.json({
      allowed: true,
      slotStatus: "ready" as const,
      sessionId,
      ...(previousSessionEnded ? { previousSessionEnded: true } : {}),
    });
  }

  // ----- Step 3b: cap reached → enqueue -----
  // queuePosition = current queue length + 1. We compute against existing
  // queued slots so positions stay 1-indexed and contiguous within the
  // user's queue (small race here under high contention; acceptable
  // because /queue-status reports rank dynamically anyway — see that
  // route).
  const queuedCount = await prisma.recordingSlot.count({
    where: { userId, status: "queued" },
  });
  const queuePosition = queuedCount + 1;

  const queuedSlot = await prisma.recordingSlot.create({
    data: {
      userId,
      sessionId: recoveredSession?.id ?? null,
      status: "queued",
      queuePosition,
    },
    select: { id: true },
  });
  void queuedSlot;

  return NextResponse.json({
    allowed: true,
    slotStatus: "queued" as const,
    queuePosition,
    ...(previousSessionEnded ? { previousSessionEnded: true } : {}),
  });
}
