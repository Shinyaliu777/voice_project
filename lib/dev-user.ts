import { auth } from "@/auth";
import { prisma } from "./db";

const DEV_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@voice.local";
const DEV_NAME = process.env.DEV_USER_NAME ?? "Dev User";

/**
 * Returns the current request's authenticated user id.
 *
 * Throws (401) if no session — callers should be wrapped in middleware
 * that has already redirected unauthenticated users to /login, but we
 * still throw here so a misconfigured route doesn't silently leak data
 * from a previously-cached dev user.
 *
 * Note: function name kept as `getDevUserId` so 46 existing routes don't
 * need to be touched right now. New code should call `requireUserId()`.
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

  throw new Error("UNAUTHENTICATED");
}

/** Preferred name for new code. Same semantics as getDevUserId. */
export const requireUserId = getDevUserId;

export async function getDevUser() {
  const id = await getDevUserId();
  return prisma.user.findUniqueOrThrow({ where: { id } });
}
