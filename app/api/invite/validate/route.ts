import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import {
  PENDING_INVITE_COOKIE,
  PENDING_INVITE_TTL_SECONDS,
} from "@/lib/invite";
import { clientIpFromHeaders, rateLimitHit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Pre-sign-in invite check. Called from the /login page when the
 * user types an invite code. If the code is pending + non-expired:
 *   - return { ok: true, inviter: { email, name } }
 *   - set a short-lived `pending_invite` cookie carrying the code
 *
 * The cookie survives the OAuth round-trip so the signIn callback in
 * auth.ts can consume it when the new user is created.
 *
 * No auth required — this endpoint runs before sign-in.
 *
 * # Anti-enumeration
 *
 * Returns the SAME error shape for "code doesn't exist", "code
 * already claimed", and "code expired" — only the message body
 * differs. Status is uniformly 404 for any "this code won't work"
 * reason. This prevents attackers from binary-searching valid codes
 * by status code (the previous version returned 404/410 distinctly,
 * exposing whether a candidate string was ever a real code).
 *
 * Also rate-limited (10 hits per IP per minute). With the 10-char
 * alphabet-32 code space (32^10 ≈ 1e15) the rate limit alone makes
 * brute force infeasible even before the anti-enumeration step.
 */
const RATE_LIMIT_PER_MIN = 10;
const MIN_CODE_LEN = 8; // generator outputs 10; refuse below 8 to
// shrink the search space we're willing to consult at all.

export async function POST(req: NextRequest) {
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimitHit(`invite-validate:${ip}`, RATE_LIMIT_PER_MIN, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "请求过于频繁，请稍后再试" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      }
    );
  }

  let body: { code?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code || code.length < MIN_CODE_LEN || code.length > 16) {
    return NextResponse.json(
      { ok: false, error: "邀请码格式不正确" },
      { status: 400 }
    );
  }

  const invitation = await prisma.invitation.findUnique({
    where: { code },
    include: {
      createdBy: { select: { email: true, name: true } },
    },
  });

  // Anti-enumeration: collapse "doesn't exist" / "claimed" / "expired"
  // into the same 404 — attackers shouldn't be able to learn which
  // codes have ever existed by probing.
  //
  // "reserved" rows: signIn passed but createUser never ran (browser
  // closed mid-OAuth). Treat as available again after a 10-minute
  // grace so a one-off failure doesn't burn the code; before that
  // it's effectively held by someone in mid-signup.
  const RESERVE_GRACE_MS = 10 * 60 * 1000;
  const reservedStillHeld =
    invitation?.status === "reserved" &&
    invitation.claimedAt !== null &&
    Date.now() - invitation.claimedAt.getTime() < RESERVE_GRACE_MS;

  const unusable =
    !invitation ||
    invitation.status === "claimed" ||
    invitation.status === "expired" ||
    reservedStillHeld ||
    (invitation?.expiresAt !== null &&
      invitation!.expiresAt.getTime() < Date.now());
  if (unusable) {
    return NextResponse.json(
      { ok: false, error: "邀请码无效或已被使用" },
      { status: 404 }
    );
  }

  const cookieStore = await cookies();
  cookieStore.set({
    name: PENDING_INVITE_COOKIE,
    value: code,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: PENDING_INVITE_TTL_SECONDS,
    path: "/",
  });

  return NextResponse.json({
    ok: true,
    inviter: {
      email: invitation!.createdBy.email,
      name: invitation!.createdBy.name,
    },
  });
}
