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
 * Persistent extra minutes added on top of Plan.monthlyMinutes. Two
 * separate buckets, both never decay:
 *
 *   - referralBonusMinutes: earned by bringing in new signups
 *   - bonusMinutes: from admin grants + redemption code top-ups
 *
 * We sum them here because the cap calculation doesn't care where
 * the bonus came from — only the user's transaction history (driven
 * by MinuteTransaction.kind) does.
 */
async function getBonusMinutes(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralBonusMinutes: true, bonusMinutes: true },
  });
  if (!user) return 0;
  return (user.referralBonusMinutes ?? 0) + (user.bonusMinutes ?? 0);
}

/**
 * Minutes of recording consumed by this user in the current calendar
 * month. The unit is wall-clock recording time — "开始录音到停止录音"
 * — regardless of whether the speaker was talking or silent. This
 * matches the user's stated policy: "本来就是只要开录音就算时间啊，
 * 用不说不说话和我们没关系". Soniox bills us by audio seconds the same
 * way, so this is what we have to bill the user by.
 *
 * Important: do NOT use Segment.audioEndMs here. That's the position
 * of the last TRANSCRIBED token from Soniox, and silent stretches
 * don't produce segments, so audioEndMs stops advancing when the
 * speaker pauses. A 30-minute recording with 20 minutes of silence
 * looks like a 10-minute recording from segments alone. Wrong cost.
 *
 * Two sources, additive (they don't overlap because Session.durationMs
 * goes null → non-null exactly once at finalize):
 *
 *   1. Session.durationMs  for sessions where finalize completed.
 *      The client computed this as `performance.now() - startedAtMs
 *      - pausedTime` so it's true wall-clock minus pause time.
 *
 *   2. sum(AudioChunk.durationMs)  for sessions still in progress.
 *      MediaRecorder produces a chunk every ~3s of WALL CLOCK time
 *      while the recorder is running. Sum tracks the active recording
 *      duration including silence.
 *
 * No status filter is needed: idle sessions that never actually
 * started recording (mic denied, user cancelled) have zero chunks
 * and zero durationMs, so they contribute zero automatically. Sessions
 * with chunks but status=idle are billed too — chunks exist only
 * because MediaRecorder actually ran, regardless of what the status
 * field says, and the user did consume capture resources.
 *
 * Time window is Session.createdAt — a session that started in May
 * counts toward May even if it finalized in June.
 */
async function getRecordingMinutesUsedThisMonth(userId: string): Promise<number> {
  const since = startOfCurrentMonth();

  // 1. Finalized sessions — durationMs is the wall-clock recording time.
  const finalized = await prisma.session.findMany({
    where: {
      userId,
      durationMs: { not: null },
      createdAt: { gte: since },
    },
    select: { durationMs: true },
  });
  let totalMs = finalized.reduce((acc, r) => acc + (r.durationMs ?? 0), 0);

  // 2. Sessions not yet finalized — sum the chunks that actually landed.
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
    const [used, bonus] = await Promise.all([
      getRecordingMinutesUsedThisMonth(userId),
      getBonusMinutes(userId),
    ]);
    // Effective cap = plan's monthly minutes + cumulative bonus minutes
    // (referral rewards + admin grants + redemption codes, all persistent).
    const baseLimit = plan.monthlyMinutes;
    const limit = baseLimit + bonus;
    const unlimited = baseLimit >= RECORDING_UNLIMITED_THRESHOLD;
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
 * Per-session breakdown of how this month's recording minutes were
 * spent. Used by the billing page's audit table so users can verify
 * the number on their own. Mirrors getRecordingMinutesUsedThisMonth's
 * accounting exactly — sum of breakdown[i].minutes equals (modulo
 * sub-minute rounding) what we report as `used` on the bar.
 */
export interface RecordingContribution {
  sessionId: string;
  title: string;
  createdAt: Date;
  status: string;
  /** Minutes this session adds to the monthly bill, rounded to 0.01. */
  minutes: number;
  /** Where the duration came from — helps explain inconsistencies. */
  source: "chunks" | "durationMs" | "none";
}

export async function getRecordingBreakdown(
  userId: string
): Promise<RecordingContribution[]> {
  const since = startOfCurrentMonth();
  const sessions = await prisma.session.findMany({
    where: { userId, createdAt: { gte: since } },
    select: {
      id: true,
      title: true,
      createdAt: true,
      status: true,
      durationMs: true,
    },
    orderBy: { createdAt: "desc" },
  });
  if (sessions.length === 0) return [];

  // For sessions that haven't been finalized we sum AudioChunk.durationMs;
  // that's MediaRecorder's wall-clock output (including silence) and
  // matches what getRecordingMinutesUsedThisMonth bills.
  const inflightIds = sessions
    .filter((s) => s.durationMs == null)
    .map((s) => s.id);
  const chunkMap = new Map<string, number>();
  if (inflightIds.length > 0) {
    const chunkSums = await prisma.audioChunk.groupBy({
      by: ["sessionId"],
      where: { sessionId: { in: inflightIds } },
      _sum: { durationMs: true },
    });
    for (const row of chunkSums) {
      chunkMap.set(row.sessionId, row._sum.durationMs ?? 0);
    }
  }

  return sessions.map((s) => {
    let contributionMs = 0;
    let source: RecordingContribution["source"] = "none";
    if (s.durationMs != null && s.durationMs > 0) {
      contributionMs = s.durationMs;
      source = "durationMs";
    } else {
      const fromChunks = chunkMap.get(s.id) ?? 0;
      if (fromChunks > 0) {
        contributionMs = fromChunks;
        source = "chunks";
      }
    }
    return {
      sessionId: s.id,
      title: s.title,
      createdAt: s.createdAt,
      status: s.status,
      minutes: Math.round((contributionMs / 60_000) * 100) / 100,
      source,
    };
  });
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
