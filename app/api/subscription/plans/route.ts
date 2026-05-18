import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

/**
 * GET /api/subscription/plans
 *
 * Public list of plans for the pricing/upgrade page. Mirrors lecsync's
 * `{plans: [...]}` shape so the same UI can consume either backend.
 *
 * Returns only active plans. Free plans (price 0) and paid plans are
 * returned in the same order; the client sorts as needed.
 */
export async function GET() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: [{ monthlyPriceCents: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      monthlyPriceCents: true,
      yearlyPriceCents: true,
      monthlyMinutes: true,
      dailyChatMessages: true,
      cloudTranslationIncluded: true,
      isPremium: true,
      isActive: true,
      isDefault: true,
      appleProductIdMonthly: true,
      appleProductIdYearly: true,
    },
  });
  return NextResponse.json({ plans });
}
