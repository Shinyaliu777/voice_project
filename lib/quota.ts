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
 * month.
 *
 * Per-session duration: max(Segment.audioEndMs, Session.durationMs ?? 0).
 *
 * Why this is the right ground truth:
 *
 *   Session.durationMs is set client-side by /api/audio/finalize using
 *   `performance.now() - startedAtMs - pausedTime`. That clock resets
 *   on page reload, on the Bug #8 layout-hoist remount, on WS
 *   reconnects, etc. — and Session.durationMs is only WRITTEN once at
 *   finalize, so any of those events makes it under-count. Users that
 *   close the tab without pressing "结束录制" don't write it at all.
 *
 *   Segment.audioEndMs comes from Soniox's audio-stream timestamps:
 *   they're absolute offsets from the start of audio sent to the WS,
 *   not wall-clock. They survive page reloads, reconnects, and "user
 *   never clicked stop". Taking max(audioEndMs) gives the furthest
 *   point in the recording timeline that actually got transcribed —
 *   the truest definition of "minutes consumed".
 *
 *   Falling back to Session.durationMs only when no segments exist
 *   keeps an edge case covered: a session where audio uploaded but
 *   Soniox WS produced no segments (network drop early, all-silence,
 *   etc.). Those are rare; without the fallback we'd under-count them.
 *
 * Time window is Session.createdAt — a session straddling a month
 * boundary counts toward the month it STARTED in. updatedAt would
 * have shifted on retranscribe / segment edits which is the wrong
 * billing semantics.
 */
async function getRecordingMinutesUsedThisMonth(userId: string): Promise<number> {
  const since = startOfCurrentMonth();

  const sessions = await prisma.session.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { id: true, durationMs: true },
  });
  if (sessions.length === 0) return 0;

  // One round-trip to pull max(audioEndMs) for every session in this
  // month — avoids N+1 queries across sessions.
  const maxEndsBySession = await prisma.segment.groupBy({
    by: ["sessionId"],
    where: { sessionId: { in: sessions.map((s) => s.id) } },
    _max: { audioEndMs: true },
  });
  const maxEndMap = new Map<string, number>();
  for (const row of maxEndsBySession) {
    maxEndMap.set(row.sessionId, row._max.audioEndMs ?? 0);
  }

  let totalMs = 0;
  for (const s of sessions) {
    const segMax = maxEndMap.get(s.id) ?? 0;
    const dur = s.durationMs ?? 0;
    // max() handles the rare case where segments exist for only part
    // of the recording (Soniox reconnect mid-session etc.) — we want
    // the furthest point either signal reached.
    totalMs += Math.max(segMax, dur);
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
  source: "segments" | "durationMs" | "none";
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

  const maxEnds = await prisma.segment.groupBy({
    by: ["sessionId"],
    where: { sessionId: { in: sessions.map((s) => s.id) } },
    _max: { audioEndMs: true },
  });
  const maxEndMap = new Map<string, number>();
  for (const r of maxEnds) maxEndMap.set(r.sessionId, r._max.audioEndMs ?? 0);

  return sessions.map((s) => {
    const segMax = maxEndMap.get(s.id) ?? 0;
    const dur = s.durationMs ?? 0;
    const contributionMs = Math.max(segMax, dur);
    let source: RecordingContribution["source"] = "none";
    if (segMax >= dur && segMax > 0) source = "segments";
    else if (dur > 0) source = "durationMs";
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
