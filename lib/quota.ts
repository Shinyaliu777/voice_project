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
 * Minutes of recording consumed by this user in the current calendar
 * month. Includes BOTH finalized sessions and any in-flight session's
 * uploaded chunks, so a user can't dodge their quota by simply never
 * pressing "结束录制" — every 3-second chunk that's already on disk
 * counts as consumed time.
 *
 * Two sources, additive (they don't overlap because Session.durationMs
 * is null until /api/audio/finalize sets it):
 *   1. Session.durationMs  for sessions where finalize completed.
 *   2. sum(AudioChunk.durationMs)  for sessions still in progress.
 *
 * Time window is Session.createdAt so a recording started in May and
 * finalized in June consistently counts as "May usage" — picking the
 * earlier of the two timestamps avoids double-counting around month
 * boundaries.
 */
async function getRecordingMinutesUsedThisMonth(userId: string): Promise<number> {
  const since = startOfCurrentMonth();

  // 1. Finalized sessions — durationMs is authoritative.
  const finalized = await prisma.session.findMany({
    where: {
      userId,
      durationMs: { not: null },
      createdAt: { gte: since },
    },
    select: { durationMs: true },
  });
  let totalMs = finalized.reduce((acc, r) => acc + (r.durationMs ?? 0), 0);

  // 2. In-flight sessions — sum the chunks that have already landed.
  //    Without this branch, an unstopped recording costs 0 quota until
  //    the user clicks "结束录制" (which they might never do — auto
  //    save on tab close goes to status=idle with durationMs still null
  //    too). The user reported "本月录音这个数肯定不准" and this is
  //    almost certainly why.
  const inflight = await prisma.session.findMany({
    where: {
      userId,
      durationMs: null,
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (inflight.length > 0) {
    const chunkAgg = await prisma.audioChunk.aggregate({
      where: { sessionId: { in: inflight.map((s) => s.id) } },
      _sum: { durationMs: true },
    });
    totalMs += chunkAgg._sum.durationMs ?? 0;
  }

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
