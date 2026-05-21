import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { prisma } from "./db";

const DEV_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@voice.local";
const DEV_NAME = process.env.DEV_USER_NAME ?? "Dev User";

/**
 * Tagged error thrown from `getDevUserId()` / `requireUserId()` when there's
 * no authenticated session. Route handlers catch this and return 401.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super("UNAUTHENTICATED");
    this.name = "UnauthenticatedError";
  }
}

/**
 * Returns the current request's authenticated user id.
 *
 * Throws `UnauthenticatedError` when no session is present — wrap in
 * `withAuth(...)` in route handlers, or `try { ... } catch (UnauthenticatedError)`.
 *
 * Note: function name kept as `getDevUserId` so 46 existing routes don't
 * need to be touched. New code should call `requireUserId()`.
 */
export async function getDevUserId(): Promise<string> {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (id) return id;

  // Last-resort fallback for non-request contexts (CLI scripts, seeds)
  // where there's no Next request to read a session from. Gated on
  // ALLOW_DEV_USER_FALLBACK to avoid letting unauthenticated API hits
  // through accidentally.
  if (process.env.ALLOW_DEV_USER_FALLBACK === "1") {
    const u = await prisma.user.upsert({
      where: { email: DEV_EMAIL },
      update: {},
      create: { email: DEV_EMAIL, name: DEV_NAME },
    });
    return u.id;
  }

  throw new UnauthenticatedError();
}

/** Preferred name for new code. Same semantics as getDevUserId. */
export const requireUserId = getDevUserId;

/**
 * Tagged error for routes that need an active (non-suspended) user.
 * Maps to a 403 response — same status code as the admin gate so
 * the SPA can show "your account has been suspended" instead of
 * bouncing to the login page.
 */
export class UserSuspendedError extends Error {
  constructor() {
    super("USER_SUSPENDED");
    this.name = "UserSuspendedError";
  }
}

/**
 * Like `requireUserId()` but also enforces `User.isSuspended = false`.
 * Use this on the few "produces resources" endpoints where letting a
 * suspended user through would cost us money or noisy infrastructure
 * pings: recording start, Soniox token mint, chat, LLM proxies.
 *
 * For read-only endpoints (history, /api/me/*) it's fine to use the
 * plain `requireUserId()` — letting a suspended user view their own
 * past sessions is a feature, not a leak.
 */
export async function requireActiveUserId(): Promise<string> {
  const id = await requireUserId();
  const u = await prisma.user.findUnique({
    where: { id },
    select: { isSuspended: true },
  });
  if (u?.isSuspended) throw new UserSuspendedError();
  return id;
}

/**
 * Wraps a route handler so `UnauthenticatedError` becomes a clean 401
 * JSON response instead of a 500. Routes can opt in incrementally —
 * any handler that doesn't use this still works, it just returns 500
 * to unauth clients (acceptable for SPA flows that get redirected
 * before hitting the API anyway).
 *
 * Usage:
 *   export const POST = withAuth(async (req) => { ... });
 */
export function withAuth<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (err instanceof UserSuspendedError) {
        return NextResponse.json(
          { error: "Account suspended" },
          { status: 403 }
        );
      }
      throw err;
    }
  };
}

export async function getDevUser() {
  const id = await getDevUserId();
  return prisma.user.findUniqueOrThrow({ where: { id } });
}
