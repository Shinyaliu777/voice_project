import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { generateInviteCode } from "@/lib/invite";

export const dynamic = "force-dynamic";

/**
 * Mint a new invite code from the caller's quota.
 *
 * Body: { note?: string }  optional human label so the inviter can
 * remember "this code is for Alice" without remembering the code.
 *
 * Atomic: user.invitationsRemaining is decremented in the same
 * transaction as the Invitation insert, so two concurrent calls can't
 * both succeed when quota is 1.
 *
 * 403 when quota is 0 — UI should hide / disable the button but the
 * server still enforces.
 */
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

  try {
    // Use `updateMany` with a where-clause on the remaining quota so the
    // decrement is racy-safe — Postgres rejects the row if another
    // request already drained quota to 0 since we last read it.
    const result = await prisma.$transaction(async (tx) => {
      const dec = await tx.user.updateMany({
        where: { id: userId, invitationsRemaining: { gt: 0 } },
        data: { invitationsRemaining: { decrement: 1 } },
      });
      if (dec.count === 0) {
        throw new QuotaExhausted();
      }
      // Retry once if we hit a duplicate code (astronomically unlikely
      // but the @unique constraint will refuse).
      for (let attempt = 0; attempt < 2; attempt++) {
        const code = generateInviteCode();
        try {
          const inv = await tx.invitation.create({
            data: {
              code,
              createdByUserId: userId,
              note: note && note.length > 0 ? note : null,
              status: "pending",
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          });
          return inv;
        } catch (err) {
          if (
            attempt === 0 &&
            err instanceof Error &&
            /Unique constraint/i.test(err.message)
          ) {
            continue;
          }
          throw err;
        }
      }
      throw new Error("Failed to generate unique code after retries");
    });

    return NextResponse.json({
      id: result.id,
      code: result.code,
      note: result.note,
      createdAt: result.createdAt.toISOString(),
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    if (err instanceof QuotaExhausted) {
      return NextResponse.json(
        { error: "邀请额度已用完" },
        { status: 403 }
      );
    }
    console.error("[invite/create]", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

class QuotaExhausted extends Error {
  constructor() {
    super("QuotaExhausted");
    this.name = "QuotaExhausted";
  }
}
