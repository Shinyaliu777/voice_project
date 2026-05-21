import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { redeemCode } from "@/lib/billing";
import { requireUserId, UnauthenticatedError } from "@/lib/dev-user";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ code: z.string().min(2).max(64) }).strict();

/** Maps RedeemError.reason to a user-facing Chinese string. */
const REASON_MESSAGES: Record<string, string> = {
  not_found: "兑换码无效",
  expired: "兑换码已过期",
  exhausted: "兑换码已被领完",
  inactive: "兑换码已停用",
  already_redeemed: "你已经兑换过这个码了",
};

/**
 * POST /api/me/redeem
 *
 * Body: { code: string }
 *
 * Success: 200 { ok: true, minutesGranted, newBalance, codeDisplay }
 * Failure: 400/409 { ok: false, error }
 */
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw err;
  }

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

  const result = await redeemCode({ userId, codeInput: parsed.data.code });
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: result.reason,
        error: REASON_MESSAGES[result.reason] ?? "兑换失败",
      },
      { status: result.reason === "already_redeemed" ? 409 : 400 }
    );
  }
  return NextResponse.json(result);
}
