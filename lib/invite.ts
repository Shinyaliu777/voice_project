/**
 * Server-only referral-code primitives.
 *
 * Registration is always open. A signup may carry an optional referral
 * code (via URL `?invite=` or the field on /login) that we use only to
 * attribute the new user back to whoever shared the code — never as a
 * gate. The same code can be reused indefinitely.
 *
 * ⚠️ This module imports `node:crypto`. NEVER import it from a client
 * component — webpack will fail with `UnhandledSchemeError`. Client
 * components should import from `@/lib/invite-format` (which has the
 * parse/format helpers without the crypto dependency); we re-export
 * them here as a convenience for server code that wants everything
 * in one place.
 */

import { randomBytes } from "node:crypto";

export { parseInviteCodeInput, formatInviteCodeForDisplay } from "./invite-format";

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
