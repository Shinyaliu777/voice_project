import { prisma } from "@/lib/db";

/**
 * Per-user quota helpers — what their current plan allows vs. what they've
 * already used this period.
 *
 * Two quotas tracked today:
 *   - `recording`: minutes of finalized audio per calendar month
 *   - `chat`: AI chat messages sent per calendar day (counts user messages)
 *
 * Both default to the user's Plan caps; missing Subscription rows fall
 * back to the platform-default Plan (mirrors lecsync's behavior).
 */

export type QuotaKind = "recording" | "chat";

export interface QuotaInfo {
  /** Plan-defined cap. 0 (or a very large number for recording) = unlimited. */
  limit: number;
  used: number;
  remaining: number;
  /** False when the user has hit or exceeded their cap. */
  allowed: boolean;
  /** Plan label like "Free" / "Business" — for UI messaging. */
  planName: string;
}

const RECORDING_UNLIMITED_THRESHOLD = 100_000; // ≈ 1700+ hours/month = effectively unlimited

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function startOfCurrentDay(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

async function resolvePlanForUser(userId: string) {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });
  if (sub) return sub.plan;
  const def = await prisma.plan.findFirst({
    where: { isDefault: true, isActive: true },
  });
  if (!def) {
    throw new Error("No default plan configured — seed the Plans table");
  }
  return def;
}

/**
 * Minutes of finalized recording in the current calendar month.
 * Uses Session.durationMs (set by /api/audio/finalize) — recordings still
 * in progress don't count yet, which matches the "you can start it before
 * checking quota" intent. Quota is checked at start time using THIS function
 * so an over-quota user can't start a NEW recording while their previous
 * one isn't yet finalized — but a single recording can run as long as it
 * wants. Good enough for Phase 2.1.
 */
async function getRecordingMinutesUsedThisMonth(userId: string): Promise<number> {
  const since = startOfCurrentMonth();
  const rows = await prisma.session.findMany({
    where: {
      userId,
      durationMs: { not: null },
      createdAt: { gte: since },
    },
    select: { durationMs: true },
  });
  const totalMs = rows.reduce((acc, r) => acc + (r.durationMs ?? 0), 0);
  return Math.round(totalMs / 60_000);
}

async function getChatMessagesUsedToday(userId: string): Promise<number> {
  const since = startOfCurrentDay();
  return await prisma.chatMessage.count({
    where: {
      role: "user",
      createdAt: { gte: since },
      chatSession: { userId },
    },
  });
}

/**
 * Look up plan + usage for a user. Cheap enough to call on every quota-gated
 * request; if it becomes a hotspot we can cache (Redis) keyed by userId.
 */
export async function getQuota(
  userId: string,
  kind: QuotaKind
): Promise<QuotaInfo> {
  const plan = await resolvePlanForUser(userId);
  if (kind === "recording") {
    const used = await getRecordingMinutesUsedThisMonth(userId);
    const limit = plan.monthlyMinutes;
    const unlimited = limit >= RECORDING_UNLIMITED_THRESHOLD;
    return {
      limit,
      used,
      remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
      allowed: unlimited || used < limit,
      planName: plan.displayName,
    };
  }
  // chat
  const used = await getChatMessagesUsedToday(userId);
  const limit = plan.dailyChatMessages;
  const unlimited = limit === 0; // 0 = unlimited (paid plans set this)
  return {
    limit,
    used,
    remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    allowed: unlimited || used < limit,
    planName: plan.displayName,
  };
}

/**
 * Convenience: throws a tagged error if over quota; route handlers catch
 * and return 402 Payment Required + plan info so the client can show an
 * "upgrade" dialog.
 */
export class QuotaExceededError extends Error {
  readonly info: QuotaInfo;
  readonly kind: QuotaKind;
  constructor(kind: QuotaKind, info: QuotaInfo) {
    super(
      `${kind} quota exceeded (${info.used} / ${info.limit} on ${info.planName})`
    );
    this.name = "QuotaExceededError";
    this.info = info;
    this.kind = kind;
  }
}

export async function ensureQuota(
  userId: string,
  kind: QuotaKind
): Promise<QuotaInfo> {
  const info = await getQuota(userId, kind);
  if (!info.allowed) throw new QuotaExceededError(kind, info);
  return info;
}
