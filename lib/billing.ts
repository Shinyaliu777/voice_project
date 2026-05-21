/**
 * Centralized helpers for changing a user's `bonusMinutes` balance.
 *
 * EVERY change to `User.bonusMinutes` MUST go through one of these
 * functions so the `MinuteTransaction` ledger stays in sync. Direct
 * `prisma.user.update({ data: { bonusMinutes: ... } })` calls
 * elsewhere would silently corrupt the running-balance invariant
 *
 *     SUM(MinuteTransaction.delta) WHERE userId = U
 *       == User.bonusMinutes
 *
 * and break the user-side transaction history.
 *
 * Each helper runs the balance read + write + ledger insert in one
 * `$transaction` so concurrent grants don't race against each other
 * (e.g. two admins clicking "grant 60 minutes" at the same time).
 */

import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "./db";

/** Discriminator values for MinuteTransaction.kind. */
export type MinuteTransactionKind =
  | "admin_grant"
  | "admin_deduct"
  | "redemption"
  | "referral_bonus"
  | "stripe_purchase"
  | "expiration";

/** Result returned by every grant/deduct helper. */
export interface MinuteChangeResult {
  /** The new `User.bonusMinutes` value after the change. */
  newBalance: number;
  /** The MinuteTransaction row id we just created (for cross-linking). */
  transactionId: string;
}

/**
 * Apply a signed delta to User.bonusMinutes AND write a ledger row.
 *
 * Negative deltas are allowed (admin clawback, expiration). We do
 * NOT clamp to zero — if an admin tries to remove more minutes than
 * the user has, the balance goes negative and quota.ts naturally
 * treats it as "no bonus minutes". Negative balances surface in the
 * admin UI as a visual warning.
 *
 * Wrap your own atomic concerns in a parent `$transaction` and pass
 * it via `tx` if you need to bundle this with other writes (e.g.
 * marking a Stripe payment as fulfilled). Otherwise we open our
 * own transaction.
 */
export async function recordMinuteChange(args: {
  userId: string;
  delta: number;
  kind: MinuteTransactionKind;
  description: string;
  metadata?: Prisma.InputJsonValue;
  tx?: Prisma.TransactionClient;
}): Promise<MinuteChangeResult> {
  const { userId, delta, kind, description, metadata, tx } = args;

  const run = async (
    client: Prisma.TransactionClient
  ): Promise<MinuteChangeResult> => {
    // Update the balance and snap the new value back in one go.
    // `increment` is server-side so two concurrent calls can't both
    // read the old balance and write back stale values.
    const updated = await client.user.update({
      where: { id: userId },
      data: { bonusMinutes: { increment: delta } },
      select: { bonusMinutes: true },
    });

    const txRow = await client.minuteTransaction.create({
      data: {
        userId,
        delta,
        kind,
        description,
        metadata: metadata ?? Prisma.JsonNull,
        balanceAfter: updated.bonusMinutes,
      },
      select: { id: true },
    });

    return { newBalance: updated.bonusMinutes, transactionId: txRow.id };
  };

  return tx ? run(tx) : prisma.$transaction(run);
}

// ---------------------------------------------------------------------
// Redemption code lifecycle
// ---------------------------------------------------------------------

/**
 * Canonicalize a user-typed code for lookup: uppercase, strip dashes
 * and whitespace. Display format is "GIFT-AB12-CD34"; storage and
 * comparison are "GIFTAB12CD34".
 */
export function canonicalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Format a stored code for display. Inserts a dash every 4 characters
 * after an optional 4-character prefix.
 */
export function formatCodeForDisplay(stored: string): string {
  if (stored.length <= 4) return stored;
  // GIFTAB12CD34 → GIFT-AB12-CD34
  return stored.match(/.{1,4}/g)?.join("-") ?? stored;
}

/**
 * Generate a fresh redemption code with a prefix tag. Default prefix
 * is "GIFT". The random part is 8 chars from an unambiguous alphabet
 * (no 0/O/1/I/L) — easy to read off a paper card or screenshot.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateCode(prefix = "GIFT", randomLen = 8): string {
  const bytes = randomBytes(randomLen);
  let suffix = "";
  for (let i = 0; i < randomLen; i++) {
    suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return canonicalizeCode(prefix + suffix);
}

/** Result returned by redeemCode. */
export interface RedeemResult {
  ok: true;
  minutesGranted: number;
  newBalance: number;
  /** Code formatted for display ("GIFT-AB12-CD34"). */
  codeDisplay: string;
}

export type RedeemError =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "exhausted" }
  | { ok: false; reason: "inactive" }
  | { ok: false; reason: "already_redeemed" };

/**
 * Atomically: look up the code, validate it's still usable, increment
 * its `usedCount`, write a Redemption row, bump the user's
 * bonusMinutes, and append a MinuteTransaction ledger entry. All-or-
 * nothing — partial state is impossible.
 *
 * Concurrency: the `Redemption_codeId_userId_key` unique index stops
 * the same user from double-redeeming. Two different users hitting
 * the same code at once are serialized by the `usedCount` update;
 * the second one sees the bumped count and either still fits under
 * `maxUses` (succeeds) or fails with "exhausted".
 */
export async function redeemCode(args: {
  userId: string;
  codeInput: string;
}): Promise<RedeemResult | RedeemError> {
  const canonical = canonicalizeCode(args.codeInput);
  if (!canonical) return { ok: false, reason: "not_found" };

  try {
    return await prisma.$transaction(async (tx) => {
      const code = await tx.redemptionCode.findUnique({
        where: { code: canonical },
      });
      if (!code) return { ok: false, reason: "not_found" } as RedeemError;
      if (!code.isActive)
        return { ok: false, reason: "inactive" } as RedeemError;
      if (code.expiresAt && code.expiresAt.getTime() < Date.now()) {
        return { ok: false, reason: "expired" } as RedeemError;
      }
      if (code.usedCount >= code.maxUses) {
        return { ok: false, reason: "exhausted" } as RedeemError;
      }

      // Pre-check the unique pair so we can surface a friendly error
      // instead of letting the create() throw P2002.
      const already = await tx.redemption.findUnique({
        where: { codeId_userId: { codeId: code.id, userId: args.userId } },
      });
      if (already) {
        return { ok: false, reason: "already_redeemed" } as RedeemError;
      }

      await tx.redemption.create({
        data: {
          codeId: code.id,
          userId: args.userId,
          minutesGranted: code.minutes,
        },
      });

      await tx.redemptionCode.update({
        where: { id: code.id },
        data: { usedCount: { increment: 1 } },
      });

      const change = await recordMinuteChange({
        userId: args.userId,
        delta: code.minutes,
        kind: "redemption",
        description: `兑换码 ${formatCodeForDisplay(code.code)}`,
        metadata: { codeId: code.id, codeDisplay: formatCodeForDisplay(code.code) },
        tx,
      });

      return {
        ok: true,
        minutesGranted: code.minutes,
        newBalance: change.newBalance,
        codeDisplay: formatCodeForDisplay(code.code),
      } as RedeemResult;
    });
  } catch (err) {
    // Fall-back: if the unique constraint trips on a race we lost,
    // map to a clean "already_redeemed".
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { ok: false, reason: "already_redeemed" };
    }
    throw err;
  }
}

/**
 * Admin-issued grant. Thin wrapper over recordMinuteChange that
 * stamps a consistent description.
 */
export async function adminGrantMinutes(args: {
  targetUserId: string;
  adminUserId: string;
  minutes: number;
  reason?: string;
}): Promise<MinuteChangeResult> {
  const description =
    args.reason && args.reason.trim().length > 0
      ? `管理员补偿 ${args.minutes >= 0 ? "+" : ""}${args.minutes} 分钟 · ${args.reason.trim()}`
      : `管理员补偿 ${args.minutes >= 0 ? "+" : ""}${args.minutes} 分钟`;

  return recordMinuteChange({
    userId: args.targetUserId,
    delta: args.minutes,
    kind: args.minutes >= 0 ? "admin_grant" : "admin_deduct",
    description,
    metadata: { adminUserId: args.adminUserId },
  });
}
