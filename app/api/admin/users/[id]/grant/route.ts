import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withAdmin } from "@/lib/admin-route";
import { adminGrantMinutes } from "@/lib/billing";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    /// Signed delta; pass negative to claw back.
    minutes: z.number().int().min(-100_000).max(100_000),
    /// Optional admin-visible reason ("welcome bonus", "refund", etc.).
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * POST /api/admin/users/[id]/grant
 *
 * Add (or subtract) `minutes` from the target user's bonusMinutes
 * balance and append a MinuteTransaction ledger row. Atomic — see
 * lib/billing.ts for the transaction shape.
 *
 * Returns the new balance + the transaction id so the admin UI can
 * snap to the updated row without re-fetching the whole list.
 */
export const POST = withAdmin(
  async (
    adminId,
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Existence pre-check so we return 404 instead of letting
    // recordMinuteChange explode with a P2025.
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const result = await adminGrantMinutes({
      targetUserId: id,
      adminUserId: adminId,
      minutes: parsed.data.minutes,
      reason: parsed.data.reason,
    });

    return NextResponse.json({
      newBalance: result.newBalance,
      transactionId: result.transactionId,
    });
  }
);
