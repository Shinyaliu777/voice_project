import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { cookies } from "next/headers";

import { prisma } from "@/lib/db";
import { PENDING_INVITE_COOKIE } from "@/lib/invite";

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
        console.warn("[auth] failed to seed default subscription", err);
      }

      // Optional referral attribution. If the signup carried a code
      // via the pending_invite cookie (set by /api/invite/validate),
      // bump the code's claimCount and stamp invitedById on the new
      // user. Codes are reusable so we don't change their status —
      // a single code can attribute any number of new users.
      try {
        const cookieStore = await cookies();
        const code = cookieStore.get(PENDING_INVITE_COOKIE)?.value;
        if (code && user.id) {
          await prisma.$transaction(async (tx) => {
            const inv = await tx.invitation.findUnique({
              where: { code },
              select: {
                id: true,
                isActive: true,
                expiresAt: true,
                createdByUserId: true,
              },
            });
            if (!inv) return;
            if (!inv.isActive) return;
            if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) return;
            await tx.invitation.update({
              where: { id: inv.id },
              data: { claimCount: { increment: 1 } },
            });
            if (user.id) {
              await tx.user.update({
                where: { id: user.id },
                data: { invitedById: inv.createdByUserId },
              });
            }
          });
          cookieStore.delete(PENDING_INVITE_COOKIE);
        }
      } catch (err) {
        // Attribution failures must never block signup.
        console.warn("[auth] failed to record referral attribution", err);
      }
    },
  },
});
