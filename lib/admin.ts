/**
 * Admin auth helpers.
 *
 * A user is treated as an admin if EITHER of these is true:
 *   1. Their email is in the `ADMIN_EMAILS` env var (comma-separated,
 *      case-insensitive). The default value is committed to
 *      `.env.production` (project owner) so a fresh deploy doesn't need
 *      raw SQL or manual env setup; ops can add more emails to that
 *      file or via `.env.production.local`.
 *   2. `User.isAdmin = true` in the database (toggleable via /admin UI
 *      once someone is already an admin).
 *
 * Both paths are checked at READ time on every request, so changes
 * (add to env file + rebuild, or flip the DB column) take effect on
 * the next request without code changes.
 */

import { auth } from "@/auth";
import { prisma } from "./db";

/**
 * Lowercased, deduped set of emails from ADMIN_EMAILS env. Recomputed
 * per call so changes to the env at runtime (e.g. systemd reload)
 * take effect without a restart.
 */
function envAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Check whether the currently-authenticated session belongs to an admin. */
export async function isCurrentUserAdmin(): Promise<{
  isAdmin: boolean;
  userId: string | null;
  email: string | null;
}> {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  const email = session?.user?.email ?? null;

  if (!userId || !email) {
    return { isAdmin: false, userId, email };
  }

  // Env path — fast, no DB hit needed.
  if (envAdminEmails().has(email.toLowerCase())) {
    return { isAdmin: true, userId, email };
  }

  // DB path — check the column.
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  });
  return { isAdmin: !!row?.isAdmin, userId, email };
}

/**
 * Tagged error for the admin gate. Routes catch this and return 403.
 * Separate type from UnauthenticatedError so the UI can distinguish
 * "log in" (401) from "you can log in but you're not an admin" (403).
 */
export class NotAdminError extends Error {
  constructor() {
    super("NOT_ADMIN");
    this.name = "NotAdminError";
  }
}

/**
 * Use inside admin route handlers and admin server components.
 * Throws `NotAdminError` (which maps to a 403) when the caller isn't
 * an admin; returns the admin's userId otherwise.
 */
export async function requireAdmin(): Promise<string> {
  const { isAdmin, userId } = await isCurrentUserAdmin();
  if (!isAdmin || !userId) throw new NotAdminError();
  return userId;
}
