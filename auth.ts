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
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
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
     * /api/invite/validate) iff INVITE_REQUIRED=1. Without the cookie,
     * we return false → NextAuth aborts before creating the row.
     *
     * The actual claim (mark Invitation as claimed + set
     * User.invitedById) happens in events.createUser below, where we
     * have the user.id.
     */
    async signIn({ user }) {
      if (!INVITE_REQUIRED) return true;
      const email = user.email?.toLowerCase().trim();
      if (!email) return false;
      const existing = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existing) return true; // existing accounts bypass the gate

      const cookieStore = await cookies();
      const pending = cookieStore.get(PENDING_INVITE_COOKIE)?.value;
      if (!pending) return false;
      // Re-check the code is still valid right now — the user could have
      // sat on the cookie past expiry, or someone else could have
      // claimed it between validate and signIn.
      const inv = await prisma.invitation.findUnique({
        where: { code: pending },
        select: { status: true, expiresAt: true },
      });
      if (!inv || inv.status !== "pending") return false;
      if (inv.expiresAt !== null && inv.expiresAt.getTime() < Date.now()) {
        return false;
      }
      return true;
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

      // Claim the pending invite if present. Atomic transaction so a
      // double-spend race resolves to one winner; the loser sees the
      // code as already claimed and the new user simply has no inviter
      // recorded — preferable to crashing signup.
      try {
        const cookieStore = await cookies();
        const code = cookieStore.get(PENDING_INVITE_COOKIE)?.value;
        if (code && user.id) {
          await prisma.$transaction(async (tx) => {
            const claim = await tx.invitation.updateMany({
              where: { code, status: "pending" },
              data: {
                status: "claimed",
                claimedByUserId: user.id,
                claimedAt: new Date(),
              },
            });
            if (claim.count === 1) {
              // Look up the inviter so we can stamp it on the new user.
              const inv = await tx.invitation.findUnique({
                where: { code },
                select: { createdByUserId: true },
              });
              if (inv && user.id) {
                await tx.user.update({
                  where: { id: user.id },
                  data: { invitedById: inv.createdByUserId },
                });
              }
            }
          });
          // Clear the cookie either way — we either claimed it or
          // someone else did.
          cookieStore.delete(PENDING_INVITE_COOKIE);
        }
      } catch (err) {
        console.warn("[auth] failed to claim invite", err);
      }
    },
  },
});
