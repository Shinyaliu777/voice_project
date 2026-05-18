import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/dev-user";

/**
 * GET /api/subscription
 *
 * Returns the current user's subscription + the embedded plan (for quota
 * fields). Mirrors lecsync's shape for forward compatibility.
 *
 * If the user has no Subscription row yet (e.g. seeded via NextAuth's
 * createUser hook before the Plans table was populated), we synthesize a
 * shallow "free default" response on the fly — that's how lecsync's
 * subscriptionSource: "default" is meant to read.
 */
export async function GET() {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (subscription) {
    return NextResponse.json({
      id: subscription.id,
      planId: subscription.planId,
      plan: subscription.plan,
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      isStripeSubscription: subscription.isStripeSubscription,
      subscriptionSource: subscription.subscriptionSource,
    });
  }

  // No subscription row — fall back to the default plan if one exists.
  const defaultPlan = await prisma.plan.findFirst({
    where: { isDefault: true, isActive: true },
  });
  if (!defaultPlan) {
    return NextResponse.json(
      { error: "No default plan configured" },
      { status: 500 }
    );
  }
  return NextResponse.json({
    id: null,
    planId: defaultPlan.id,
    plan: defaultPlan,
    status: "ACTIVE",
    billingCycle: "MONTHLY",
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    isStripeSubscription: false,
    subscriptionSource: "default",
  });
}
