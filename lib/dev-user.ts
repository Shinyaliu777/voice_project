import { prisma } from "./db";

const DEV_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@voice.local";
const DEV_NAME = process.env.DEV_USER_NAME ?? "Dev User";

let cachedId: string | null = null;

/**
 * Returns the dev user's id. Creates the row on first call.
 * Phase 1 has no real auth — every request belongs to this user.
 */
export async function getDevUserId(): Promise<string> {
  if (cachedId) return cachedId;
  const user = await prisma.user.upsert({
    where: { email: DEV_EMAIL },
    update: {},
    create: { email: DEV_EMAIL, name: DEV_NAME },
  });
  cachedId = user.id;
  return user.id;
}

export async function getDevUser() {
  const id = await getDevUserId();
  return prisma.user.findUniqueOrThrow({ where: { id } });
}
