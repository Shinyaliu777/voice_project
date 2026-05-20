import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId, UnauthenticatedError } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * Release ONE active recording slot for the caller.
 *
 * Body (optional): { sessionId?: string }
 *   - When provided, release only the active slot whose
 *     `sessionId` matches. This is the normal path called from the
 *     Recorder client at stop time.
 *   - When omitted, release the oldest active slot. Lets the UI call
 *     this from an "abort" handler without tracking sessionId.
 *
 * Why scoped: when paid plans push `maxConcurrentRecordings` above 1
 * (multi-tab recording), a global "release ALL active" would silently
 * kick out the other tab. We now release exactly one slot per call.
 *
 * Effect (inside an advisory-lock transaction so concurrent releases
 * don't double-promote a queued slot):
 *   1. Mark the targeted slot status="released" (status, releasedAt).
 *      We mark instead of delete so the audit trail survives.
 *   2. If — and only if — that release dropped the user's active
 *      count below the cap, auto-promote the next queued slot.
 *      Promoting requires both that the queue's head slot isn't
 *      itself stale (`claimedAt` older than QUEUE_STALE_MS).
 *   3. Rebase remaining queued positions to 1..N.
 *
 * Idempotent: returns { ok: true } even if the user had no active slot.
 */

const QUEUE_STALE_MS = 10 * 60 * 1000;

const releaseBodySchema = z
  .object({
    sessionId: z.string().optional(),
  })
  .optional();

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

  // Body is optional. If something is sent and it's malformed, fall
  // back to "release any one" rather than 400'ing — the contract from
  // the client's perspective is best-effort.
  let targetSessionId: string | undefined;
  try {
    if (req.headers.get("content-length") !== "0") {
      const body = await req.json().catch(() => undefined);
      const parsed = releaseBodySchema.safeParse(body);
      if (parsed.success && parsed.data) {
        targetSessionId = parsed.data.sessionId;
      }
    }
  } catch {
    /* ignore */
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`;

    // 1. Find the slot to release.
    let toRelease;
    if (targetSessionId) {
      toRelease = await tx.recordingSlot.findFirst({
        where: { userId, status: "active", sessionId: targetSessionId },
        select: { id: true },
      });
    } else {
      toRelease = await tx.recordingSlot.findFirst({
        where: { userId, status: "active" },
        orderBy: [{ claimedAt: "asc" }],
        select: { id: true },
      });
    }
    if (!toRelease) return; // nothing to release

    await tx.recordingSlot.update({
      where: { id: toRelease.id },
      data: { status: "released", releasedAt: new Date() },
    });

    // 2. Decide whether to auto-promote. We re-read the cap and the
    // remaining active count under the lock so the math is honest.
    const [user, remainingActive] = await Promise.all([
      tx.user.findUnique({
        where: { id: userId },
        select: { maxConcurrentRecordings: true },
      }),
      tx.recordingSlot.count({
        where: { userId, status: "active" },
      }),
    ]);
    const maxConcurrent = user?.maxConcurrentRecordings ?? 1;

    if (remainingActive >= maxConcurrent) return;

    // Look for the next queued slot that isn't itself stale. A stale
    // queued slot would otherwise promote into a phantom active row
    // that permanently blocks the user (since the client behind it is
    // long gone).
    const staleCutoff = new Date(Date.now() - QUEUE_STALE_MS);
    const nextQueued = await tx.recordingSlot.findFirst({
      where: {
        userId,
        status: "queued",
        claimedAt: { gt: staleCutoff },
      },
      orderBy: [{ queuePosition: "asc" }, { claimedAt: "asc" }],
      select: { id: true },
    });

    // Mark any queued slots that ARE stale as released up front so
    // they don't sit in the queue forever; cheap to do here while we
    // hold the lock.
    await tx.recordingSlot.updateMany({
      where: {
        userId,
        status: "queued",
        claimedAt: { lt: staleCutoff },
      },
      data: { status: "released", releasedAt: new Date() },
    });

    if (nextQueued) {
      await tx.recordingSlot.update({
        where: { id: nextQueued.id },
        data: { status: "active", queuePosition: null },
      });
    }

    // 3. Rebase remaining (still-queued) positions.
    const remaining = await tx.recordingSlot.findMany({
      where: { userId, status: "queued" },
      orderBy: [{ queuePosition: "asc" }, { claimedAt: "asc" }],
      select: { id: true },
    });
    for (let i = 0; i < remaining.length; i++) {
      await tx.recordingSlot.update({
        where: { id: remaining[i].id },
        data: { queuePosition: i + 1 },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
