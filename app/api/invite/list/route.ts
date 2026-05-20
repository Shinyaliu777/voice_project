import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * List every referral code the current user has minted, with how
 * many new users each code has attributed.
 *
 * Returns: {
 *   invitations: Array<{
 *     id, code, note, isActive, claimCount, createdAt, expiresAt,
 *     recentClaimers: Array<{ email, name, createdAt }>
 *   }>
 * }
 *
 * `recentClaimers` is the last 5 users brought in by this code,
 * shown so the inviter sees "Alice, Bob, ..." for confirmation. Past
 * 5 are just folded into the `claimCount`.
 */
export async function GET() {
  const userId = await getDevUserId();

  const [user, invitations, recentInvitees] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { referralBonusMinutes: true },
    }),
    prisma.invitation.findMany({
      where: { createdByUserId: userId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    }),
    // We don't track per-code claims (no join table), only "this
    // user was invited by you". Show the most recent ones so the
    // inviter sees confirmation of who actually arrived.
    prisma.user.findMany({
      where: { invitedById: userId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { email: true, name: true, createdAt: true },
    }),
  ]);

  return NextResponse.json({
    referralBonusMinutes: user?.referralBonusMinutes ?? 0,
    invitations: invitations.map((inv) => ({
      id: inv.id,
      code: inv.code,
      note: inv.note,
      isActive: inv.isActive,
      claimCount: inv.claimCount,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt?.toISOString() ?? null,
    })),
    recentInvitees: recentInvitees.map((u) => ({
      email: u.email,
      name: u.name,
      createdAt: u.createdAt.toISOString(),
    })),
  });
}
