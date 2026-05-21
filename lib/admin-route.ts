/**
 * Tiny wrapper used by /api/admin/* route handlers. Same shape as
 * `withAuth` from lib/dev-user.ts but enforces the admin gate as
 * well. Returns 401 for unauthenticated callers, 403 for logged-in
 * non-admins.
 */

import { NextResponse } from "next/server";

import { NotAdminError, requireAdmin } from "./admin";
import { UnauthenticatedError } from "./dev-user";

export function withAdmin<TArgs extends unknown[]>(
  handler: (adminUserId: string, ...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs) => {
    try {
      const adminUserId = await requireAdmin();
      return await handler(adminUserId, ...args);
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (err instanceof NotAdminError) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      throw err;
    }
  };
}
