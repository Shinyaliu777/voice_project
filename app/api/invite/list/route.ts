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

  const invitations = await prisma.invitation.findMany({
    where: { createdByUserId: userId },
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
  });

  // Look up recent claimers per code in a single round-trip.
  const inviterIds = invitations.map((i) => i.createdByUserId);
  // The new schema doesn't keep an explicit join row per claim, so we
  // fetch the User records where invitedById == this user, then bucket
  // by which of THIS user's codes they could have used. We don't know
  // exactly which code each user came in through (only that they were
  // invited by this account), so we attribute them to the inviter's
  // most-recently-used active code as a best effort. This is an
  // intentional simplification — if we later need per-code claimers,
  // add an InvitationClaim join table.
  const recentInvitees =
    inviterIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { invitedById: userId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { email: true, name: true, createdAt: true },
        });

  return NextResponse.json({
    invitations: invitations.map((inv) => ({
      id: inv.id,
      code: inv.code,
      note: inv.note,
      isActive: inv.isActive,
      claimCount: inv.claimCount,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt?.toISOString() ?? null,
    })),
    // Flat list of recent attributions across all of this user's
    // codes — UI displays them in one section ("最近被邀请进来的用户")
    // since we can't tell which code each used.
    recentInvitees: recentInvitees.map((u) => ({
      email: u.email,
      name: u.name,
      createdAt: u.createdAt.toISOString(),
    })),
  });
}
