import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { requireUserId, UnauthenticatedError } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

/**
 * GET /api/me/transactions
 *
 * Paginated minute-transaction history for the current user. Powers
 * lecsync's "查看历史交易流水记录" expander inside the billing dialog.
 *
 * Query params:
 *   - take:   page size (default 30, max 100)
 *   - cursor: id of the last row from the previous page
 */
export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const url = new URL(req.url);
  const take = Math.min(
    Math.max(parseInt(url.searchParams.get("take") ?? "30", 10) || 30, 1),
    100
  );
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const rows = await prisma.minuteTransaction.findMany({
    where: { userId },
    take: take + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      delta: true,
      kind: true,
      description: true,
      balanceAfter: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return NextResponse.json({
    transactions: page,
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  });
}
