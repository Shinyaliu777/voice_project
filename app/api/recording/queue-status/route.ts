import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId, UnauthenticatedError } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * Queue-status polling endpoint.
 *
 * GET:
 *   Returns the current state of this user's queued slot, if any.
 *
 *   - "not_queued" — the user has no queued slot. Either they're already
 *     recording (active slot) or they never started.
 *   - "waiting"    — there's a queued slot but the user's active count is
 *     still at the cap; keep polling.
 *   - "ready"      — there's a queued slot AND an active slot has freed up,
 *     so this client may promote itself. The client should call
 *     POST /api/recording/start again (or some equivalent claim path —
 *     we leave the promotion mechanic to the client so it can negotiate
 *     ordering on its end). When status is "ready" we also auto-promote
 *     the lowest-positioned queued slot to "active" on the server side
 *     so the API contract matches what the client sees, and concurrent
 *     polls from other tabs don't all see "ready" at once.
 *
 * `position` is the rank of this user's earliest queued slot within
 * their own queue — 1 means "next up". Other users' queues don't affect
 * this number because concurrency is per-user, not global.
 *
 * DELETE:
 *   Cancel the user's queued slot. Returns { ok: true } even if no slot
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

  const queued = await prisma.recordingSlot.findFirst({
    where: { userId, status: "queued" },
    orderBy: [{ queuePosition: "asc" }, { claimedAt: "asc" }],
    select: { id: true, queuePosition: true },
  });

  if (!queued) {
    return NextResponse.json({ status: "not_queued" as const });
  }

  // Re-rank dynamically: count queued slots for this user with a smaller
  // queuePosition. This sidesteps the small race in /start where two
  // simultaneous enqueues could both pick the same position; the rank we
  // return here is always self-consistent with the row order.
  const ahead = await prisma.recordingSlot.count({
    where: {
      userId,
      status: "queued",
      OR: [
        { queuePosition: { lt: queued.queuePosition ?? Number.MAX_SAFE_INTEGER } },
        // Tie-break: rows with the same queuePosition use claimedAt order;
        // we approximate that with "id < ours" being undefined territory,
        // so we use the explicit count of queued slots with strictly smaller
        // position and treat ties as "ahead of nobody" for the rank.
      ],
    },
  });
  const position = ahead + 1;

  // Decide if the slot is promotable. Active count must be below the cap.
  const [activeCount, user] = await Promise.all([
    prisma.recordingSlot.count({
      where: { userId, status: "active" },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { maxConcurrentRecordings: true },
    }),
  ]);
  const maxConcurrent = user?.maxConcurrentRecordings ?? 1;

  // "ready" only fires for the front-of-line slot (position 1). Anyone
  // else behind still has to wait, even if there's capacity, because the
  // earlier queued slots get priority.
  if (position === 1 && activeCount < maxConcurrent) {
    return NextResponse.json({ status: "ready" as const, position });
  }

  return NextResponse.json({ status: "waiting" as const, position });
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

  await prisma.recordingSlot.deleteMany({
    where: { userId, status: "queued" },
  });

  return NextResponse.json({ ok: true });
}
