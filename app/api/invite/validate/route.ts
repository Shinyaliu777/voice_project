import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import {
  PENDING_INVITE_COOKIE,
  PENDING_INVITE_TTL_SECONDS,
} from "@/lib/invite";

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
 */
export async function POST(req: NextRequest) {
  let body: { code?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code || code.length < 6 || code.length > 16) {
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

  if (!invitation) {
    return NextResponse.json(
      { ok: false, error: "邀请码无效" },
      { status: 404 }
    );
  }
  if (invitation.status === "claimed") {
    return NextResponse.json(
      { ok: false, error: "此邀请码已被使用" },
      { status: 410 }
    );
  }
  const expired =
    invitation.status === "expired" ||
    (invitation.expiresAt !== null &&
      invitation.expiresAt.getTime() < Date.now());
  if (expired) {
    return NextResponse.json(
      { ok: false, error: "此邀请码已过期" },
      { status: 410 }
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
