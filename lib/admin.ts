/**
 * Admin auth helpers.
 *
 * A user is treated as an admin if ANY of these is true:
 *   1. Their email is in `OWNER_EMAILS` below (hardcoded — project owner,
 *      can't be turned off via env, survives any deploy misconfig)
 *   2. Their email is in the `ADMIN_EMAILS` env var (comma-separated,
 *      case-insensitive). For ops to add more admins without a code change.
 *   3. `User.isAdmin = true` in the database (toggleable via /admin UI
 *      once someone is already an admin)
 *
 * The env + hardcode paths are checked at READ time on every request,
 * so adding/removing emails takes effect on the next request without a
 * restart (for env) or a redeploy (for hardcode requires it though).
 */

import { auth } from "@/auth";
import { prisma } from "./db";

/**
 * Project owner emails — always treated as admin, regardless of DB or
 * env state. Hardcoded so a fresh deploy on an empty DB doesn't lock
 * the owner out, and so an ops mistake clearing $ADMIN_EMAILS doesn't
 * accidentally demote them. Lowercased + dash-stripped at compare time.
 *
 * Adding a new permanent owner: append below and redeploy. Day-to-day
 * admin grants should go through the /admin UI (DB column) or
 * ADMIN_EMAILS env var instead.
 */
const OWNER_EMAILS = new Set<string>([
  "shinyaliu777@gmail.com",
]);

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

  const emailLower = email.toLowerCase();

  // Owner path — hardcoded, survives any deploy misconfig.
  if (OWNER_EMAILS.has(emailLower)) {
    return { isAdmin: true, userId, email };
  }

  // Env path — fast, no DB hit needed.
  if (envAdminEmails().has(emailLower)) {
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
