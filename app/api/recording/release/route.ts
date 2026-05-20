import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId, UnauthenticatedError } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * Release the caller's active recording slot.
 *
 * Effect:
 *   1. Marks every "active" slot for this user as "released"
 *      (status="released", releasedAt=now). We mark instead of delete so
 *      the audit trail survives — useful for billing disputes later.
 *   2. Auto-promotes the lowest-`queuePosition` queued slot (if any) to
 *      "active". The client polling `/queue-status` will then see status
 *      "ready" and proceed.
 *   3. Rebases the remaining queue so positions stay 1-indexed (cosmetic;
 *      the rank-by-count math in /queue-status is correct either way, but
 *      keeping the column tidy helps debugging).
 *
 * Idempotent: returns { ok: true } even if the user had no active slot.
 */

export async function POST() {
  let userId: string;
  try {
    userId = await getDevUserId();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  await prisma.$transaction(async (tx) => {
    // 1. Release any active slots for this user.
    await tx.recordingSlot.updateMany({
      where: { userId, status: "active" },
      data: { status: "released", releasedAt: new Date() },
    });

    // 2. Find next-in-line queued slot.
    const nextQueued = await tx.recordingSlot.findFirst({
      where: { userId, status: "queued" },
      orderBy: [{ queuePosition: "asc" }, { claimedAt: "asc" }],
      select: { id: true },
    });

    if (nextQueued) {
      await tx.recordingSlot.update({
        where: { id: nextQueued.id },
        data: { status: "active", queuePosition: null },
      });

      // 3. Rebase the remaining queue so positions remain 1..N. Pull all
      // still-queued slots in order, then renumber. Small queues so the
      // double-loop is fine.
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
    }
  });

  return NextResponse.json({ ok: true });
}
