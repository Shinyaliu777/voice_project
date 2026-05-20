/**
 * Invite-only closed-beta primitives.
 *
 * Three pieces:
 *   - `generateInviteCode()` — opaque 10-char alphanumeric (no ambiguous
 *     glyphs like 0/O/1/I/l). Used as the bearer credential.
 *   - `INVITE_REQUIRED` — boolean from env; when true, sign-in callback
 *     blocks new account creation without a valid pending_invite cookie.
 *   - cookie helpers — set/read/clear the `pending_invite` cookie that
 *     carries the (validated) code through the NextAuth OAuth round-trip.
 *
 * The actual DB row + lifecycle is owned by the API routes
 * (/api/invite/{create,list,validate}) and the signIn callback in auth.ts.
 */

import { randomBytes } from "node:crypto";

// I/l/1, O/0 removed to avoid copy-paste ambiguity ("did you mean Il?")
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
 * Beta gate. When true:
 *   - /api/invite/validate must succeed (writes pending_invite cookie)
 *     before a new account can be created via NextAuth.
 *   - The signIn callback in auth.ts rejects new-user creation if no
 *     valid pending_invite cookie is present.
 *
 * Existing users (those already in the DB) bypass this — sign-in for
 * existing accounts is always permitted.
 *
 * Default: false (open registration). Set INVITE_REQUIRED=1 in prod
 * to flip the gate on for the closed beta.
 */
export const INVITE_REQUIRED = process.env.INVITE_REQUIRED === "1";

/** Initial invite quota seeded onto every new user (defaults to 0 for
 *  closed beta — admin manually bumps trusted users). Override via
 *  INVITE_INITIAL_QUOTA env. */
export function initialInviteQuota(): number {
  const raw = Number.parseInt(process.env.INVITE_INITIAL_QUOTA ?? "0", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

// ---------- cookie helpers ----------

export const PENDING_INVITE_COOKIE = "pending_invite";
/** 15 minutes — long enough to complete an OAuth round-trip + click
 *  through Google consent, short enough that an abandoned signup
 *  doesn't leave a stale code lying around. */
export const PENDING_INVITE_TTL_SECONDS = 60 * 15;
