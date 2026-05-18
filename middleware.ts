import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Gate `/dashboard/*` (and a few API surfaces) behind a logged-in user.
 *
 * Live-share viewer (/share/live/[token]) is intentionally NOT gated —
 * it's public by design. All `/api/auth/*` routes are also unguarded so
 * NextAuth's own flow keeps working.
 *
 * Note: NextAuth v5's `auth()` works as a middleware-style wrapper too,
 * but we use it imperatively here so we can keep the matcher narrow.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = !!req.auth;

  // Public routes — let through.
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/share/live") ||
    pathname === "/login"
  ) {
    return NextResponse.next();
  }

  // Anything under /dashboard requires a session.
  if (pathname.startsWith("/dashboard")) {
    if (!isLoggedIn) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
});

export const config = {
  // Skip Next internals, static assets, and image opt API.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
