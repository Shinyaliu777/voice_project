import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import {
  INVITE_REQUIRED,
  PENDING_INVITE_COOKIE,
  initialInviteQuota,
} from "@/lib/invite";

/**
 * NextAuth (Auth.js v5) configuration.
 *
 * Providers:
 *   - Google OAuth (production)
 *   - "credentials" with a single `email` field — DEV-MODE ONLY. Lets a
 *     developer "log in" as any email locally without setting up Google
 *     OAuth credentials. Disabled in production via the env flag.
 *
 * Session strategy: JWT (no Session DB table required, which is good
 * because our existing `Session` Prisma model is for recording sessions).
 *
 * Seeding: when a brand-new user is created we auto-attach the default
 * Plan (free) via the `events.createUser` hook. If no default Plan
 * exists yet (e.g. fresh DB before `prisma/seed.ts` ran), the
 * Subscription create is skipped — quota code treats no-Subscription as
 * "free tier" anyway.
 */
const allowDevLogin =
  process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_LOGIN === "1";

const hasGoogle =
  !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

// CRITICAL SAFETY GUARD: dev-login + Google together in prod is a
// take-over-anyone attack — the dev-login credentials provider does an
// upsert on email, so typing "victim@example.com" yields a session as
// that user even if they originally signed up via Google. Bail at
// import time if both flags are set in production; this can't be
// recovered from at request time.
if (
  process.env.NODE_ENV === "production" &&
  hasGoogle &&
  process.env.ALLOW_DEV_LOGIN === "1"
) {
  throw new Error(
    "[auth] Refusing to boot: ALLOW_DEV_LOGIN=1 with Google OAuth enabled in production is an account-takeover vector. Disable one."
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  // We deploy behind nginx, which forwards the original Host (e.g.
  // voice.cyanclay.org). Without this, Auth.js v5 throws UntrustedHost on
  // /api/auth/* in production and every server-side `auth()` call fails,
  // cascading into UNAUTHENTICATED on dashboard/api routes.
  trustHost: true,
  // Routes /login + /api/auth/error etc.
  pages: {
    signIn: "/login",
  },
  providers: [
    ...(hasGoogle
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    ...(allowDevLogin
      ? [
          Credentials({
            id: "dev-login",
            name: "Dev login (no password)",
            credentials: {
              email: { label: "Email", type: "email" },
            },
            async authorize(creds) {
              const email = String(creds?.email ?? "").trim().toLowerCase();
              if (!email || !/^.+@.+\..+$/.test(email)) return null;
              // Upsert the user so dev logins work on a fresh DB without
              // a prior OAuth flow.
              const u = await prisma.user.upsert({
                where: { email },
                update: {},
                create: {
                  email,
                  name: email.split("@")[0],
                },
              });
              return { id: u.id, email: u.email, name: u.name ?? null };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    /**
     * Invite-only beta gate.
     *
     * Existing users (email already in DB) always sign in. New accounts
     * require a valid `pending_invite` cookie (set by
     * /api/invite/validate). To prevent two browsers using the same code
     * from both succeeding (the original implementation re-read status
     * and then proceeded, leaving a race window), we atomically reserve
     * the code here:
     *
     *   UPDATE Invitation
     *      SET status = 'reserved', claimedAt = now()
     *    WHERE code = ? AND status = 'pending' AND (expiresAt is null OR expiresAt > now())
     *
     * Only one updateMany wins. The createUser hook below then upgrades
     * the row to 'claimed' once the user.id is available. If createUser
     * never runs (e.g. sign-in aborts mid-flow), reserved rows are
     * treated as available again by /validate after a grace window.
     *
     * Case sensitivity: Postgres `String @unique` is case-sensitive,
     * but NextAuth providers return the email in whatever case the
     * upstream IdP uses. We compare via `findFirst` with `mode:
     * "insensitive"` so Foo@Gmail.com and foo@gmail.com map to the
     * same row.
     */
    async signIn({ user }) {
      if (!INVITE_REQUIRED) return true;
      const email = user.email?.toLowerCase().trim();
      if (!email) return false;
      const existing = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) return true; // existing accounts bypass the gate

      const cookieStore = await cookies();
      const pending = cookieStore.get(PENDING_INVITE_COOKIE)?.value;
      if (!pending) return false;

      // Atomic reserve — pending→reserved. Only one concurrent sign-in
      // can flip the row, so simultaneous sign-ups with the same code
      // resolve to one winner. Also recovers `reserved` rows older
      // than RESERVE_GRACE_MS — they're presumed abandoned by a
      // browser that crashed mid-OAuth.
      const RESERVE_GRACE_MS = 10 * 60 * 1000;
      const staleReservedCutoff = new Date(Date.now() - RESERVE_GRACE_MS);
      const reserved = await prisma.invitation.updateMany({
        where: {
          code: pending,
          OR: [
            { status: "pending" },
            { status: "reserved", claimedAt: { lt: staleReservedCutoff } },
          ],
          AND: [
            {
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          ],
        },
        data: { status: "reserved", claimedAt: new Date() },
      });
      return reserved.count === 1;
    },
    async jwt({ token, user }) {
      // `user` is only present on initial sign-in. Persist the DB id
      // onto the JWT so subsequent requests can read it from `auth()`.
      if (user) {
        token.id = (user as { id?: string }).id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.id && session.user) {
        (session.user as { id?: string }).id = token.id as string;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      // Auto-attach the default plan as a Free subscription so quota
      // checks have something to read from.
      try {
        const defaultPlan = await prisma.plan.findFirst({
          where: { isDefault: true, isActive: true },
        });
        if (defaultPlan && user.id) {
          await prisma.subscription.upsert({
            where: { userId: user.id },
            create: {
              userId: user.id,
              planId: defaultPlan.id,
              status: "ACTIVE",
              subscriptionSource: "default",
            },
            update: {},
          });
        }
      } catch (err) {
        // Don't block signup on subscription seeding.
        console.warn("[auth] failed to seed default subscription", err);
      }

      // Seed initial invite quota from env (default 0 for closed beta).
      if (user.id) {
        const quota = initialInviteQuota();
        if (quota > 0) {
          await prisma.user
            .update({
              where: { id: user.id },
              data: { invitationsRemaining: quota },
            })
            .catch((err) =>
              console.warn("[auth] failed to seed invite quota", err)
            );
        }
      }

      // Finalize the invite claim that signIn() reserved. By the time
      // we're here, the row is already status='reserved' with
      // claimedAt set — we just need to upgrade to 'claimed' and
      // attach claimedByUserId/invitedById. If signIn somehow let us
      // through without a reserve (shouldn't happen when
      // INVITE_REQUIRED is on, but possible when it's off and the
      // user pasted a code anyway), we skip silently.
      try {
        const cookieStore = await cookies();
        const code = cookieStore.get(PENDING_INVITE_COOKIE)?.value;
        if (code && user.id) {
          await prisma.$transaction(async (tx) => {
            const inv = await tx.invitation.findUnique({
              where: { code },
              select: { status: true, createdByUserId: true },
            });
            if (!inv) return;
            // INVITE_REQUIRED path: row is 'reserved' from signIn.
            // INVITE_REQUIRED-off path: row is still 'pending'. Accept
            // both so a wide-open instance with codes can still
            // attribute invitations correctly.
            if (inv.status !== "reserved" && inv.status !== "pending") {
              return;
            }
            const claim = await tx.invitation.updateMany({
              where: {
                code,
                status: { in: ["reserved", "pending"] },
                claimedByUserId: null,
              },
              data: {
                status: "claimed",
                claimedByUserId: user.id,
                claimedAt: new Date(),
              },
            });
            if (claim.count === 1 && user.id) {
              await tx.user.update({
                where: { id: user.id },
                data: { invitedById: inv.createdByUserId },
              });
            }
          });
          cookieStore.delete(PENDING_INVITE_COOKIE);
        }
      } catch (err) {
        console.warn("[auth] failed to claim invite", err);
      }
    },
  },
});
