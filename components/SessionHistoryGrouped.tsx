"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { SessionDTO } from "@/lib/contracts";
import {
  SessionCard,
  flagFor,
  type FolderChoice,
} from "@/components/SessionCard";
import { cn } from "@/lib/utils";

type BucketKey =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "older";

const BUCKET_ORDER: ReadonlyArray<BucketKey> = [
  "today",
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "older",
];

const BUCKET_LABEL: Record<BucketKey, string> = {
  today: "今天",
  yesterday: "昨天",
  thisWeek: "本周",
  lastWeek: "上周",
  thisMonth: "本月",
  older: "更早",
};

/** Build a Date at local midnight for the given day. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday-start ISO week. Returns the Date at the start of this week's Monday. */
function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0=Sun..6=Sat
  // Distance back to Monday: Sun(0)->6, Mon(1)->0, ... Sat(6)->5
  const back = (day + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  return monday;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function bucketFor(createdAt: string, now: Date): BucketKey {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return "older";

  const today = startOfDay(now).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const weekStart = startOfWeek(now).getTime();
  const lastWeekStart = weekStart - 7 * 24 * 60 * 60 * 1000;
  const monthStart = startOfMonth(now).getTime();

  if (t >= today) return "today";
  if (t >= yesterday) return "yesterday";
  // 本周 excludes today/yesterday
  if (t >= weekStart) return "thisWeek";
  if (t >= lastWeekStart) return "lastWeek";
  // 本月 excludes today/yesterday/this-week/last-week. Use month start as floor.
  if (t >= monthStart) return "thisMonth";
  return "older";
}

function langPairKey(s: SessionDTO): string {
  return `${s.sourceLang}|${s.targetLang}`;
}

function langPairLabel(key: string): string {
  const [src, tgt] = key.split("|");
  if (!src || !tgt) return key;
  return `${flagFor(src)} ${src.toUpperCase()} → ${flagFor(tgt)} ${tgt.toUpperCase()}`;
}

type StatusFilter = "all" | "ready" | "idle" | "error";

const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "ready", label: "已完成" },
  { value: "idle", label: "草稿" },
  { value: "error", label: "出错" },
];

export interface SessionHistoryGroupedProps {
  sessions: SessionDTO[];
  /** Search query from the URL (?q=…). When non-empty, also filters by title. */
  query?: string;
  /** Folders available to move a session into. Forwarded to each
   *  SessionCard so the per-card dropdown can open a move dialog. */
  folders?: FolderChoice[];
}

export function SessionHistoryGrouped({
  sessions,
  query,
  folders = [],
}: SessionHistoryGroupedProps) {
  const [langFilter, setLangFilter] = React.useState<string>("all");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");

  // Stable "now" snapshot for bucketing so cards don't visibly jump buckets
  // while the user toggles filters. The snapshot is taken on first mount and
  // refreshed whenever the upstream session list changes (e.g. router.refresh
  // after a rename / delete).
  const nowRef = React.useRef<Date>(new Date());
  // Re-snapshot whenever the sessions identity changes.
  const lastSessionsRef = React.useRef(sessions);
  if (lastSessionsRef.current !== sessions) {
    lastSessionsRef.current = sessions;
    nowRef.current = new Date();
  }
  const now = nowRef.current;

  // Unique source→target pairs derived from the dataset.
  const langPairs = React.useMemo(() => {
    const seen = new Set<string>();
    for (const s of sessions) seen.add(langPairKey(s));
    return Array.from(seen).sort();
  }, [sessions]);

  // Reset the lang filter if it no longer matches any session.
  React.useEffect(() => {
    if (langFilter !== "all" && !langPairs.includes(langFilter)) {
      setLangFilter("all");
    }
  }, [langFilter, langPairs]);

  const trimmedQuery = (query ?? "").trim();

  const filtered = React.useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    return sessions.filter((s) => {
      if (langFilter !== "all" && langPairKey(s) !== langFilter) return false;
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      if (q && !(s.title || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sessions, langFilter, statusFilter, trimmedQuery]);

  const groups = React.useMemo(() => {
    const map = new Map<BucketKey, SessionDTO[]>();
    for (const s of filtered) {
      const key = bucketFor(s.createdAt, now);
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [filtered, now]);

  // ----- Empty states -----
  if (sessions.length === 0) {
    return (
      <div className="rounded-[10px] border border-dashed border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
        <div className="mb-2 flex justify-center text-zinc-400">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="mb-3">还没有录音</div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 transition hover:bg-zinc-800"
        >
          去录第一段 →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Filter chips */}
      <div className="flex flex-col gap-3">
        <FilterRow label="语言">
          <Chip
            active={langFilter === "all"}
            onClick={() => setLangFilter("all")}
          >
            全部
          </Chip>
          {langPairs.map((pair) => (
            <Chip
              key={pair}
              active={langFilter === pair}
              onClick={() => setLangFilter(pair)}
            >
              {langPairLabel(pair)}
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="状态">
          {STATUS_FILTERS.map((f) => (
            <Chip
              key={f.value}
              active={statusFilter === f.value}
              onClick={() => setStatusFilter(f.value)}
            >
              {f.label}
            </Chip>
          ))}
        </FilterRow>

        {trimmedQuery ? (
          <div className="text-xs text-zinc-500">
            正在过滤包含「{trimmedQuery}」的录音 ·{" "}
            <span className="font-medium text-zinc-700">
              {filtered.length}
            </span>{" "}
            条结果
          </div>
        ) : null}
      </div>

      {/* Grouped cards */}
      {filtered.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-zinc-200 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          {trimmedQuery || langFilter !== "all" || statusFilter !== "all"
            ? "没有匹配的录音 — 试着调整一下筛选条件"
            : "暂无录音"}
        </div>
      ) : (
        BUCKET_ORDER.map((key) => {
          const items = groups.get(key);
          if (!items || items.length === 0) return null;
          return (
            <section key={key}>
              <h3 className="mb-3 flex items-baseline gap-2 text-sm font-medium text-zinc-700">
                <span>{BUCKET_LABEL[key]}</span>
                <span className="text-xs font-normal text-zinc-400">
                  {items.length}
                </span>
              </h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {items.map((s) => (
                  <SessionCard key={s.id} session={s} folders={folders} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

// ---------- internal chip primitives ----------

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-wide text-zinc-400">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition",
        active
          ? "border-zinc-900 bg-zinc-900 text-zinc-50 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800"
      )}
    >
      {children}
    </button>
  );
}

export default SessionHistoryGrouped;
