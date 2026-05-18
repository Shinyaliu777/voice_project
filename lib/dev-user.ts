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
      throw err;
    }
  };
}

export async function getDevUser() {
  const id = await getDevUserId();
  return prisma.user.findUniqueOrThrow({ where: { id } });
}
