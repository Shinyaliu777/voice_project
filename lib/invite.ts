/**
 * Referral-code primitives.
 *
 * Registration is always open. A signup may carry an optional referral
 * code (via URL `?invite=` or the field on /login) that we use only to
 * attribute the new user back to whoever shared the code — never as a
 * gate. The same code can be reused indefinitely.
 *
 *   - `generateInviteCode()` — opaque 10-char alphanumeric from a
 *     no-ambiguous-glyph alphabet (no 0/O/1/I/l).
 *   - `parseInviteCodeInput()` — accept whatever the user pasted
 *     (with spaces / dashes / lowercase) and normalize.
 *   - `PENDING_INVITE_COOKIE` — short-lived HTTP-only cookie that
 *     carries the (validated) code through the NextAuth OAuth
 *     round-trip so events.createUser can stamp it.
 */

import { randomBytes } from "node:crypto";

// I/l/1, O/0 removed so users typing a code never have to puzzle over
// "did you mean Il?".
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_LENGTH = 10;

export function generateInviteCode(length = DEFAULT_LENGTH): string {
  // Reject-sampling via randomBytes — bias-free, no need for full
  // crypto.randomInt loops.
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 256 - (256 % ALPHABET.length)) {
      out += ALPHABET[b % ALPHABET.length];
    }
  }
  if (out.length < length) {
    // Astronomically unlikely; fall back to a fresh draw.
    return generateInviteCode(length);
  }
  return out;
}

/**
 * Normalize whatever the user pasted into the canonical form.
 * Strips spaces and dashes, uppercases, trims. Lets the inviter
 * share a friendlier-looking `K3X9-P7L2-MR` without breaking lookup.
 */
export function parseInviteCodeInput(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/** Display form: insert a dash every 4 chars so the code is scannable. */
export function formatInviteCodeForDisplay(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

export const PENDING_INVITE_COOKIE = "pending_invite";
/** 30 minutes — long enough to complete an OAuth round-trip + click
 *  through Google consent + take a coffee break. Plenty of slack
 *  since the cookie no longer locks the code (it's just an attribution
 *  carrier). */
export const PENDING_INVITE_TTL_SECONDS = 60 * 30;

/**
 * Minutes of recording the inviter gets credited per successful new
 * signup that uses their code. Lecsync's stub UI mentioned +60/invite
 * up to 1500, so we match that bar by default. Override via env if
 * you want to dial the incentive up or down.
 *
 * No self-referral payout — auth.ts events.createUser compares the
 * inviter's email (lowercased) to the new user's email and skips the
 * bonus if they match.
 */
export function referralBonusMinutes(): number {
  const raw = Number.parseInt(process.env.REFERRAL_BONUS_MINUTES ?? "60", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60;
}
