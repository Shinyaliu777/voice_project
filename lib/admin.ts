/**
 * Admin auth helpers.
 *
 * A user is treated as an admin if EITHER of these is true:
 *   1. `User.isAdmin = true` in the database (preferred path; toggle via
 *      /admin UI once someone is already an admin)
 *   2. Their email appears in the `ADMIN_EMAILS` env var (comma-separated,
 *      case-insensitive). Bootstraps the first admin without raw SQL.
 *
 * The env-var path is checked at READ time on every request; you can
 * remove an email from the list and they're locked out next request.
 * Combined with the DB column, deployments can promote/demote admins
 * either via env (ops-flavored) or via UI (product-flavored).
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
