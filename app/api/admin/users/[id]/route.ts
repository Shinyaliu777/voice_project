import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withAdmin } from "@/lib/admin-route";
import { prisma } from "@/lib/db";
import { getQuota } from "@/lib/quota";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users/[id]
 *
 * Detail card for a single user. Includes:
 *   - profile fields (email, name, signup, flags)
 *   - current plan + this-month usage (via lib/quota)
 *   - bonus + referral balances
 *   - last 30 minute transactions (running balance)
 *   - referrer (if any) and the codes they've issued
 */
export const GET = withAdmin(
  async (
    _adminId,
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        createdAt: true,
        bonusMinutes: true,
        referralBonusMinutes: true,
        isAdmin: true,
        isSuspended: true,
        maxConcurrentRecordings: true,
        invitedById: true,
        invitedBy: { select: { id: true, email: true, name: true } },
        subscription: {
          select: {
            plan: { select: { name: true, displayName: true, monthlyMinutes: true } },
            status: true,
            currentPeriodEnd: true,
            subscriptionSource: true,
          },
        },
        _count: { select: { invitedUsers: true, sessions: true } },
      },
    });
    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Recording usage this month (computed in lib/quota for parity with
    // the user-facing /api/me/billing endpoint — same numbers everywhere).
    const recording = await getQuota(user.id, "recording");

    const transactions = await prisma.minuteTransaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        delta: true,
        kind: true,
        description: true,
        balanceAfter: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      user,
      recording: {
        limit: recording.limit,
        used: recording.used,
        remaining:
          recording.remaining === Number.POSITIVE_INFINITY
            ? null
            : recording.remaining,
      },
      transactions,
    });
  }
);

/**
 * PATCH /api/admin/users/[id]
 *
 * Toggle the admin or suspend flags on a user. Body:
 *   { isAdmin?: boolean, isSuspended?: boolean }
 */
const patchBody = z
  .object({
    isAdmin: z.boolean().optional(),
    isSuspended: z.boolean().optional(),
  })
  .strict();

export const PATCH = withAdmin(
  async (
    adminId,
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;
    if (id === adminId) {
      // Refuse to let an admin demote/suspend THEMSELVES — easy way to
      // accidentally lock yourself out of /admin.
      return NextResponse.json(
        { error: "Cannot modify your own admin/suspend flags" },
        { status: 400 }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = patchBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await prisma.user.update({
      where: { id },
      data: parsed.data,
      select: { id: true, isAdmin: true, isSuspended: true },
    });
    return NextResponse.json(updated);
  }
);
