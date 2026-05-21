import { NextResponse, type NextRequest } from "next/server";

import { withAdmin } from "@/lib/admin-route";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users
 *
 * Paginated list of all users with the bits the admin table needs:
 * email/name, signup date, current plan name, recording usage this
 * month, bonus minutes balance, referral count, suspend/admin flags.
 *
 * Query params:
 *   - q:     case-insensitive email/name substring filter
 *   - take:  page size (default 50, max 200)
 *   - cursor: id of the last row from the previous page
 *   - sort:  "recent" (default, by createdAt desc) | "minutes_used"
 */
export const GET = withAdmin(async (_adminId, req: NextRequest) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const take = Math.min(
    Math.max(parseInt(url.searchParams.get("take") ?? "50", 10) || 50, 1),
    200
  );
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const where = q
    ? {
        OR: [
          { email: { contains: q, mode: "insensitive" as const } },
          { name: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : undefined;

  // We can't sort by minutes_used cheaply at the DB layer (it's a sum
  // over Session.durationMs + AudioChunk.durationMs); leave that as a
  // future optimization. Default "recent" matches what admins usually
  // want anyway ("who signed up today?").
  const rows = await prisma.user.findMany({
    where,
    take: take + 1, // peek one to detect next page
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { createdAt: "desc" },
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
      subscription: {
        select: { plan: { select: { displayName: true, monthlyMinutes: true } } },
      },
      _count: { select: { invitedUsers: true, sessions: true } },
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return NextResponse.json({
    users: page.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      image: u.image,
      createdAt: u.createdAt,
      planName: u.subscription?.plan.displayName ?? "Free",
      monthlyMinutes: u.subscription?.plan.monthlyMinutes ?? 0,
      bonusMinutes: u.bonusMinutes,
      referralBonusMinutes: u.referralBonusMinutes,
      referralCount: u._count.invitedUsers,
      sessionCount: u._count.sessions,
      isAdmin: u.isAdmin,
      isSuspended: u.isSuspended,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  });
});
