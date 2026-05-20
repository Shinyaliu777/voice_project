/**
 * Client-safe invite-code formatting helpers.
 *
 * Kept separate from `lib/invite.ts` because that module imports
 * `node:crypto` (server-only). Anything imported by a client
 * component must NOT transitively pull in node:* schemes — webpack
 * bails with `UnhandledSchemeError` when building the browser bundle.
 *
 * Both functions are pure / idempotent.
 */

/**
 * Normalize whatever the user pasted into the canonical form.
 * Strips spaces and dashes, uppercases. Lets the inviter share a
 * friendlier-looking `K3X9-P7L2-MR` without breaking lookup.
 */
export function parseInviteCodeInput(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/** Display form: insert a dash every 4 chars so the code is scannable. */
export function formatInviteCodeForDisplay(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}
