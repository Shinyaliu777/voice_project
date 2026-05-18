import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ---- Plans (lecsync-parity: Free default + Business paid) ----
  const free = await prisma.plan.upsert({
    where: { name: "free" },
    update: {
      displayName: "Free",
      description: "免费档：每月 120 分钟录音 · 每日 20 条 AI 对话",
      monthlyPriceCents: 0,
      yearlyPriceCents: 0,
      monthlyMinutes: 120,
      dailyChatMessages: 20,
      cloudTranslationIncluded: true,
      isPremium: false,
      isActive: true,
      isDefault: true,
    },
    create: {
      name: "free",
      displayName: "Free",
      description: "免费档：每月 120 分钟录音 · 每日 20 条 AI 对话",
      monthlyPriceCents: 0,
      yearlyPriceCents: 0,
      monthlyMinutes: 120,
      dailyChatMessages: 20,
      cloudTranslationIncluded: true,
      isPremium: false,
      isActive: true,
      isDefault: true,
    },
  });
  const business = await prisma.plan.upsert({
    where: { name: "business" },
    update: {
      displayName: "Business",
      description: "无限录音 · 无限 AI 对话 · 高级模型 · 优先支持",
      monthlyPriceCents: 5999,
      yearlyPriceCents: 35999,
      monthlyMinutes: 999999,
      dailyChatMessages: 0, // 0 = unlimited in code
      cloudTranslationIncluded: true,
      isPremium: true,
      isActive: true,
      isDefault: false,
    },
    create: {
      name: "business",
      displayName: "Business",
      description: "无限录音 · 无限 AI 对话 · 高级模型 · 优先支持",
      monthlyPriceCents: 5999,
      yearlyPriceCents: 35999,
      monthlyMinutes: 999999,
      dailyChatMessages: 0,
      cloudTranslationIncluded: true,
      isPremium: true,
      isActive: true,
      isDefault: false,
    },
  });
  console.log("Seeded plans:", { free: free.id, business: business.id });

  // ---- Dev user + auto-subscribe to Free ----
  // Kept for local dev workflows that bypass NextAuth (e.g. running scripts
  // against a fresh DB before any user has signed in).
  const email = process.env.DEV_USER_EMAIL ?? "dev@voice.local";
  const name = process.env.DEV_USER_NAME ?? "Dev User";
  const user = await prisma.user.upsert({
    where: { email },
    update: { name },
    create: { email, name },
  });
  await prisma.subscription.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      planId: free.id,
      status: "ACTIVE",
      subscriptionSource: "default",
    },
  });
  console.log("Seeded dev user:", {
    id: user.id,
    email: user.email,
    plan: "free",
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
