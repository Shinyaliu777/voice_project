import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";

import { prisma } from "@/lib/db";

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
        if (!defaultPlan || !user.id) return;
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
      } catch (err) {
        // Don't block signup on subscription seeding.
        console.warn("[auth] failed to seed default subscription", err);
      }
    },
  },
});
