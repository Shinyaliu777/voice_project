import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { generateInviteCode } from "@/lib/invite";

export const dynamic = "force-dynamic";

/**
 * Mint a reusable referral code for the current user.
 *
 * Body (optional): { note?: string } — human label so the inviter can
 * remember "this code is for my podcast / for Alice / for the
 * marketing email".
 *
 * Referral codes are not consumable: one code can be applied by any
 * number of new signups. The only per-user limit is `MAX_CODES_PER_USER`
 * below — purely an anti-clutter cap (a user with 20 active codes
 * in their dashboard is probably doing something funny). Disable
 * old codes via PATCH /api/invite/[id] (TODO) when you've outgrown
 * this limit; existing attributions are preserved.
 */

const MAX_CODES_PER_USER = 20;

export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

  let body: { note?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 80) : null;

  // Soft cap on number of ACTIVE codes per user. Disabled codes don't
  // count — flipping isActive on an old code is the right way to make
  // room.
  const activeCount = await prisma.invitation.count({
    where: { createdByUserId: userId, isActive: true },
  });
  if (activeCount >= MAX_CODES_PER_USER) {
    return NextResponse.json(
      {
        error: `已达活跃邀请码上限（${MAX_CODES_PER_USER}）。请先禁用一些旧的邀请码。`,
      },
      { status: 409 }
    );
  }

  // Retry once if we hit a duplicate code (astronomically unlikely
  // but the @unique constraint will refuse).
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generateInviteCode();
    try {
      const inv = await prisma.invitation.create({
        data: {
          code,
          createdByUserId: userId,
          note: note && note.length > 0 ? note : null,
          // No default expiry — referral codes are for long-term
          // attribution. Inviter can set one via PATCH later.
        },
      });
      return NextResponse.json({
        id: inv.id,
        code: inv.code,
        note: inv.note,
        isActive: inv.isActive,
        claimCount: inv.claimCount,
        createdAt: inv.createdAt.toISOString(),
        expiresAt: inv.expiresAt?.toISOString() ?? null,
      });
    } catch (err) {
      if (
        attempt === 0 &&
        err instanceof Error &&
        /Unique constraint/i.test(err.message)
      ) {
        continue;
      }
      console.error("[invite/create]", err);
      return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
  }
  return NextResponse.json({ error: "Server error" }, { status: 500 });
}
