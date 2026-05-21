import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId, UnauthenticatedError } from "@/lib/dev-user";
import { getQuota } from "@/lib/quota";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/billing
 *
 * One-shot payload for the user-side "订阅与账单" dialog:
 *
 *   - subscription:    current Plan + status + period
 *   - recording:       this-month minutes used vs effective limit
 *   - bonusMinutes:    grants + redemptions (persistent)
 *   - referralBonus:   referrals only (persistent)
 *   - admin:           is the caller an admin (so the UI can show
 *                      a discreet "管理后台" entry without a separate
 *                      probe request)
 */
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      image: true,
      bonusMinutes: true,
      referralBonusMinutes: true,
      isAdmin: true,
      isSuspended: true,
      subscription: {
        include: { plan: true },
      },
    },
  });
  if (!user) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const recording = await getQuota(userId, "recording");

  return NextResponse.json({
    user: {
      email: user.email,
      name: user.name,
      image: user.image,
      isAdmin: user.isAdmin,
      isSuspended: user.isSuspended,
    },
    subscription: user.subscription
      ? {
          planName: user.subscription.plan.displayName,
          planSlug: user.subscription.plan.name,
          monthlyMinutes: user.subscription.plan.monthlyMinutes,
          monthlyPriceCents: user.subscription.plan.monthlyPriceCents,
          yearlyPriceCents: user.subscription.plan.yearlyPriceCents,
          isPremium: user.subscription.plan.isPremium,
          status: user.subscription.status,
          billingCycle: user.subscription.billingCycle,
          currentPeriodEnd: user.subscription.currentPeriodEnd,
          source: user.subscription.subscriptionSource,
        }
      : null,
    recording: {
      limit: recording.limit,
      used: recording.used,
      remaining:
        recording.remaining === Number.POSITIVE_INFINITY
          ? null
          : recording.remaining,
      allowed: recording.allowed,
      planName: recording.planName,
    },
    bonusMinutes: user.bonusMinutes,
    referralBonusMinutes: user.referralBonusMinutes,
  });
}
