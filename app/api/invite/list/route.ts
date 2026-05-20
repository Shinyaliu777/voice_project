import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * List every invitation the current user has minted, plus their
 * remaining quota.
 *
 * Returns: {
 *   invitationsRemaining: number,
 *   invitations: Array<{
 *     id, code, note, status, createdAt, expiresAt, claimedAt,
 *     claimedBy?: { email, name }
 *   }>
 * }
 *
 * `code` is included so the inviter can copy + share. `claimedBy` is
 * the email of the person who used it (so the inviter can see "Alice
 * joined!"); we only include claimedBy when status === "claimed".
 */
export async function GET() {
  const userId = await getDevUserId();

  const [user, invitations] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { invitationsRemaining: true },
    }),
    prisma.invitation.findMany({
      where: { createdByUserId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        claimedBy: { select: { email: true, name: true } },
      },
    }),
  ]);

  if (!user) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Lazily mark stale pending rows as expired so the UI shows the right
  // status without a separate maintenance job.
  const now = Date.now();
  const expired = invitations.filter(
    (inv) =>
      inv.status === "pending" &&
      inv.expiresAt !== null &&
      inv.expiresAt.getTime() < now
  );
  if (expired.length > 0) {
    await prisma.invitation
      .updateMany({
        where: { id: { in: expired.map((i) => i.id) } },
        data: { status: "expired" },
      })
      .catch(() => {});
  }

  return NextResponse.json({
    invitationsRemaining: user.invitationsRemaining,
    invitations: invitations.map((inv) => ({
      id: inv.id,
      code: inv.code,
      note: inv.note,
      status:
        expired.find((e) => e.id === inv.id) !== undefined
          ? "expired"
          : inv.status,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt?.toISOString() ?? null,
      claimedAt: inv.claimedAt?.toISOString() ?? null,
      claimedBy:
        inv.status === "claimed" && inv.claimedBy
          ? {
              email: inv.claimedBy.email,
              name: inv.claimedBy.name ?? null,
            }
          : null,
    })),
  });
}
