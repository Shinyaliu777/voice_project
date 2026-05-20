import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import {
  PENDING_INVITE_COOKIE,
  PENDING_INVITE_TTL_SECONDS,
  parseInviteCodeInput,
} from "@/lib/invite";
import { clientIpFromHeaders, rateLimitHit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Optional referral-code check.
 *
 * Called from the /login page if the user pastes a code. If valid:
 *   - returns { ok: true, inviter: { email, name } } so the UI can
 *     display "你接受了 X 的邀请"
 *   - sets a short-lived cookie carrying the code through the OAuth
 *     round-trip; on first sign-in events.createUser bumps the code's
 *     claimCount and stamps invitedById
 *
 * Signup never requires a code. This endpoint exists only to provide
 * feedback ("this code works") and carry attribution forward.
 *
 * Rate-limited (15 hits per IP per minute) and refuses very short
 * inputs to prevent casual enumeration of the code space. We don't
 * return distinct status codes for "doesn't exist" vs "disabled" vs
 * "expired" — all three collapse to 404 with the same message — so
 * an attacker can't binary-search whether a candidate string was
 * ever a real code.
 */
const RATE_LIMIT_PER_MIN = 15;
const MIN_CODE_LEN = 8; // generator outputs 10 — refuse 6-char fishing.

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
  const code = parseInviteCodeInput(String(body.code ?? ""));
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

  const expired =
    invitation?.expiresAt !== null &&
    invitation?.expiresAt !== undefined &&
    invitation.expiresAt.getTime() < Date.now();

  if (!invitation || !invitation.isActive || expired) {
    return NextResponse.json(
      {
        ok: false,
        error: "邀请码无效或已失效，请确认后重试或联系发码人",
      },
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
      email: invitation.createdBy.email,
      name: invitation.createdBy.name,
    },
  });
}
