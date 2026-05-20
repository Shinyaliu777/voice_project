import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId, UnauthenticatedError } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * Queue-status polling endpoint.
 *
 * GET:
 *   Returns the current state of this user's queued slot, if any, and
 *   atomically auto-promotes that slot to active when there's room.
 *
 *   - "not_queued" — the user has no queued slot. Either they're already
 *     recording (active slot) or they never started.
 *   - "waiting"    — there's a queued slot but the user's active count is
 *     still at the cap; keep polling.
 *   - "ready"      — the user's front-of-line queued slot was atomically
 *     promoted to "active" on the server in this same call. The
 *     `sessionId` (if the queued slot already carried one — e.g. via
 *     recoverySessionId) is included. The client should immediately
 *     proceed to open Soniox WS / call /start with init=false.
 *
 *   Running auto-promote under the same per-user advisory lock that
 *   /start and /release use makes the "ready" answer authoritative:
 *   only the call that won the race returns it, and the promoted slot
 *   is already active in the DB by the time the client sees the
 *   response.
 *
 * `position` is the rank of this user's earliest queued slot within
 * their own queue — 1 means "next up". Other users' queues don't affect
 * this number because concurrency is per-user, not global.
 *
 * DELETE:
 *   Cancel the user's queued slots. Returns { ok: true } even if no slot
 *   existed (idempotent — clients are expected to fire this on tab close
 *   without checking first).
 */

export async function GET() {
  let userId: string;
  try {
    userId = await getDevUserId();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`;

    const queued = await tx.recordingSlot.findFirst({
      where: { userId, status: "queued" },
      orderBy: [{ queuePosition: "asc" }, { claimedAt: "asc" }],
      select: { id: true, queuePosition: true, sessionId: true },
    });
    if (!queued) {
      return { status: "not_queued" as const };
    }

    // Rank within this user's queue. "ahead" = how many of this user's
    // queued slots have a strictly smaller queuePosition.
    const ahead = await tx.recordingSlot.count({
      where: {
        userId,
        status: "queued",
        queuePosition: {
          lt: queued.queuePosition ?? Number.MAX_SAFE_INTEGER,
        },
      },
    });
    const position = ahead + 1;

    const [activeCount, user] = await Promise.all([
      tx.recordingSlot.count({ where: { userId, status: "active" } }),
      tx.user.findUnique({
        where: { id: userId },
        select: { maxConcurrentRecordings: true },
      }),
    ]);
    const maxConcurrent = user?.maxConcurrentRecordings ?? 1;

    // Only the front-of-line slot is eligible; even with extra capacity
    // we don't leapfrog the ordering.
    if (position === 1 && activeCount < maxConcurrent) {
      await tx.recordingSlot.update({
        where: { id: queued.id },
        data: { status: "active", queuePosition: null },
      });
      return {
        status: "ready" as const,
        position,
        sessionId: queued.sessionId ?? null,
      };
    }
    return { status: "waiting" as const, position };
  });

  return NextResponse.json(result);
}

export async function DELETE() {
  let userId: string;
  try {
    userId = await getDevUserId();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  // Mark rather than delete so the audit trail survives (matches what
  // /release does for active slots).
  await prisma.recordingSlot.updateMany({
    where: { userId, status: "queued" },
    data: { status: "released", releasedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
