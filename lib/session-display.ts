/**
 * Pure helpers for rendering Session metadata. Lives outside any
 * `"use client"` component so server components (e.g. the session
 * detail page) can call them too — otherwise Next.js rejects
 * server-side invocation of a client-marked export.
 */

/**
 * Title to actually show in lists. Empty + the legacy
 * `new Date().toLocaleString()` default that polluted older sessions
 * both fall back to a YYYY-MM-DD HH:mm derived from createdAt — the
 * real creation time — instead of the misleading string. Detection
 * regex matches zh-CN locale "YYYY/M/D[ ,]HH:MM:SS" with optional
 * leading zeros so the prior "2026/5/18 08:46:48" form collapses
 * naturally.
 */
export function displaySessionTitle(
  rawTitle: string | null | undefined,
  createdAt: string | Date
): string {
  const t = (rawTitle ?? "").trim();
  const looksLikeAutoTimestamp =
    /^\d{4}\/\d{1,2}\/\d{1,2}[\s,]+\d{1,2}:\d{2}(?::\d{2})?$/.test(t);
  if (!t || looksLikeAutoTimestamp) {
    const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
    if (!Number.isFinite(d.getTime())) return "未命名录音";
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }
  return t;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}秒`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}分${s}秒`;
}
