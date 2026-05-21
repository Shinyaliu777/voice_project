import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import {
  requireActiveUserId,
  UnauthenticatedError,
  UserSuspendedError,
} from "@/lib/dev-user";

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
    userId = await requireActiveUserId();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof UserSuspendedError) {
      return NextResponse.json(
        { error: "Account suspended" },
        { status: 403 }
      );
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

  // ----- Read-only validation (cheap, no need to hold the per-user
  // advisory lock for these). Folder + recovery-session ownership
  // checks. -----
  if (folderId) {
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
      select: { userId: true },
    });
    if (!folder || folder.userId !== userId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
  }

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

  // ----- Per-user advisory lock + transactional slot allocation -----
  // Without this, two simultaneous POSTs from one user (two tabs both
  // clicking 开始录音) both passed the cap check and both created
  // status="active" slots — silently violating maxConcurrentRecordings.
  // pg_advisory_xact_lock is auto-released at COMMIT/ROLLBACK so we
  // can't leak the lock by forgetting to free it. The hashtext()
  // collision space (32-bit) is good enough for our user-id namespace.
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`;

    // Sweep stale active slots (session.updatedAt older than cutoff).
    const activeSlots = await tx.recordingSlot.findMany({
      where: { userId, status: "active" },
      orderBy: { claimedAt: "asc" },
    });

    let previousSessionEnded = false;
    const liveSlotIds: string[] = [];
    if (activeSlots.length > 0) {
      const sessionIds = activeSlots
        .map((s) => s.sessionId)
        .filter((s): s is string => s != null);
      const sessions =
        sessionIds.length > 0
          ? await tx.session.findMany({
              where: { id: { in: sessionIds } },
              select: { id: true, updatedAt: true },
            })
          : [];
      const sessionMap = new Map(sessions.map((s) => [s.id, s.updatedAt]));
      const cutoff = Date.now() - STALE_SLOT_MS;
      const staleSlotIds: string[] = [];
      for (const slot of activeSlots) {
        if (!slot.sessionId) {
          // Active slot without a session: rare — typically a queued
          // slot was just promoted but the client never finished setup.
          // If claimedAt is itself stale, treat as dead; otherwise alive.
          if (slot.claimedAt.getTime() < cutoff) {
            staleSlotIds.push(slot.id);
          } else {
            liveSlotIds.push(slot.id);
          }
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
        await tx.recordingSlot.updateMany({
          where: { id: { in: staleSlotIds } },
          data: { status: "released", releasedAt: new Date() },
        });
        previousSessionEnded = true;
      }
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { maxConcurrentRecordings: true },
    });
    const maxConcurrent = user?.maxConcurrentRecordings ?? 1;
    const activeCount = liveSlotIds.length;

    // Room available → create active slot + session
    if (activeCount < maxConcurrent) {
      let sessionId: string;
      if (recoveredSession) {
        sessionId = recoveredSession.id;
      } else {
        const created = await tx.session.create({
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
      await tx.recordingSlot.create({
        data: {
          userId,
          sessionId,
          status: "active",
          queuePosition: null,
        },
      });
      return {
        slotStatus: "ready" as const,
        sessionId,
        previousSessionEnded,
      };
    }

    // Cap reached → enqueue. queuePosition is counted under the lock
    // so two concurrent enqueues get distinct positions.
    const queuedCount = await tx.recordingSlot.count({
      where: { userId, status: "queued" },
    });
    const queuePosition = queuedCount + 1;
    await tx.recordingSlot.create({
      data: {
        userId,
        sessionId: recoveredSession?.id ?? null,
        status: "queued",
        queuePosition,
      },
    });
    return {
      slotStatus: "queued" as const,
      queuePosition,
      previousSessionEnded,
    };
  });

  if (result.slotStatus === "ready") {
    return NextResponse.json({
      allowed: true,
      slotStatus: "ready" as const,
      sessionId: result.sessionId,
      ...(result.previousSessionEnded ? { previousSessionEnded: true } : {}),
    });
  }
  return NextResponse.json({
    allowed: true,
    slotStatus: "queued" as const,
    queuePosition: result.queuePosition,
    ...(result.previousSessionEnded ? { previousSessionEnded: true } : {}),
  });
}
