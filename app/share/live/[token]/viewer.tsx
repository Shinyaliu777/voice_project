"use client";

import * as React from "react";
import { Radio, WifiOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SegmentDTO, SessionDTO, Utterance } from "@/lib/contracts";

interface LiveShareViewerProps {
  token: string;
  initialTitle: string;
  sourceLang: string;
  targetLang: string;
}

interface DisplayUtterance {
  /** Stable id — utterance id while in-flight; segment id once finalized. */
  id: string;
  speakerId: number | null;
  startMs: number;
  sourceText: string;
  translatedText: string;
  isFinal: boolean;
}

type Action =
  | { type: "init"; segments: SegmentDTO[]; session: SessionDTO }
  | { type: "utterance"; value: Utterance }
  | { type: "segment"; value: SegmentDTO; utteranceId?: string };

interface State {
  title: string;
  order: string[];
  byId: Record<string, DisplayUtterance>;
  /** Maps an in-flight utterance id to its finalized segment id (once the
   *  segment has been persisted). Used so we can splice the segment update
   *  into the slot the utterance already occupies, instead of appending a
   *  duplicate card under the segment's CUID. */
  utteranceToSegment: Record<string, string>;
}

function initial(initialTitle: string): State {
  return {
    title: initialTitle,
    order: [],
    byId: {},
    utteranceToSegment: {},
  };
}

function fromSegment(seg: SegmentDTO): DisplayUtterance {
  return {
    id: seg.id,
    speakerId: seg.speakerId,
    startMs: seg.audioStartMs,
    sourceText: seg.sourceText ?? "",
    translatedText: seg.translatedText ?? "",
    isFinal: !!seg.isFinal,
  };
}

function fromUtterance(u: Utterance): DisplayUtterance {
  return {
    id: u.id,
    speakerId: u.speakerId ?? null,
    startMs: u.startMs,
    sourceText: u.sourceText ?? "",
    translatedText: u.translatedText ?? "",
    isFinal: !!u.isFinal,
  };
}

/** Tolerance in ms when matching two events to the same utterance slot by
 *  (speaker, startMs). Soniox sometimes rewinds endMs/startMs by a few hundred
 *  ms across emits, so an exact equality check would miss duplicates. */
const SAME_SLOT_TOLERANCE_MS = 1500;

function findSlotByPosition(
  state: State,
  speakerId: number | null,
  startMs: number
): string | null {
  for (const id of state.order) {
    const u = state.byId[id];
    if (!u) continue;
    if (u.speakerId !== speakerId) continue;
    if (Math.abs(u.startMs - startMs) <= SAME_SLOT_TOLERANCE_MS) return id;
  }
  return null;
}

/** Replace a slot's key (e.g. swap in-flight utterance id for persisted segment
 *  id) without reordering. */
function replaceSlotKey(
  state: State,
  oldId: string,
  newId: string,
  payload: DisplayUtterance
): State {
  if (oldId === newId) {
    return { ...state, byId: { ...state.byId, [newId]: payload } };
  }
  const byId: Record<string, DisplayUtterance> = {};
  for (const [k, v] of Object.entries(state.byId)) {
    if (k !== oldId) byId[k] = v;
  }
  byId[newId] = payload;
  const order = state.order.map((id) => (id === oldId ? newId : id));
  return { ...state, byId, order };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "init": {
      const byId: Record<string, DisplayUtterance> = {};
      const order: string[] = [];
      for (const seg of action.segments) {
        byId[seg.id] = fromSegment(seg);
        order.push(seg.id);
      }
      return {
        title: action.session.title || state.title,
        order,
        byId,
        utteranceToSegment: {},
      };
    }
    case "utterance": {
      const next = fromUtterance(action.value);
      // 1. Already mapped to a finalized segment slot — route there.
      const mappedSegId = state.utteranceToSegment[next.id];
      if (mappedSegId && state.byId[mappedSegId]) {
        return replaceSlotKey(state, mappedSegId, mappedSegId, {
          ...next,
          id: mappedSegId,
        });
      }
      // 2. Slot already exists under this exact utterance id — update in place.
      if (state.byId[next.id]) {
        return { ...state, byId: { ...state.byId, [next.id]: next } };
      }
      // 3. Same speaker + similar startMs — merge into the existing slot rather
      //    than appending a duplicate card. (Soniox sometimes re-emits an
      //    utterance under a new id after a sentence split + immediate
      //    re-finalize; without this we get two cards at the same timestamp.)
      const neighborId = findSlotByPosition(state, next.speakerId, next.startMs);
      if (neighborId) {
        // Merge: prefer the longer source text, prefer existing translation if
        // the new one is empty, otherwise take the new one.
        const prev = state.byId[neighborId];
        const merged: DisplayUtterance = {
          id: neighborId,
          speakerId: next.speakerId,
          startMs: Math.min(prev.startMs, next.startMs),
          sourceText:
            next.sourceText.length >= prev.sourceText.length
              ? next.sourceText
              : prev.sourceText,
          translatedText:
            next.translatedText.length >= prev.translatedText.length
              ? next.translatedText
              : prev.translatedText,
          isFinal: prev.isFinal || next.isFinal,
        };
        return { ...state, byId: { ...state.byId, [neighborId]: merged } };
      }
      // 4. Brand new slot.
      return {
        ...state,
        byId: { ...state.byId, [next.id]: next },
        order: [...state.order, next.id],
      };
    }
    case "segment": {
      const next = fromSegment(action.value);
      const uid = action.utteranceId;
      // 1. Segment knows its utterance — swap that slot's key in place.
      if (uid && state.byId[uid]) {
        const ns = replaceSlotKey(state, uid, next.id, next);
        return {
          ...ns,
          utteranceToSegment: { ...ns.utteranceToSegment, [uid]: next.id },
        };
      }
      // 2. Segment id already known (e.g. PATCH update) — update in place.
      if (state.byId[next.id]) {
        return { ...state, byId: { ...state.byId, [next.id]: next } };
      }
      // 3. No mapping but a card already exists at this (speaker, startMs) —
      //    treat it as the same utterance and swap the slot key.
      const neighborId = findSlotByPosition(state, next.speakerId, next.startMs);
      if (neighborId) {
        const ns = replaceSlotKey(state, neighborId, next.id, next);
        return uid
          ? {
              ...ns,
              utteranceToSegment: { ...ns.utteranceToSegment, [uid]: next.id },
            }
          : ns;
      }
      // 4. Brand new slot.
      const byId = { ...state.byId, [next.id]: next };
      const order = [...state.order, next.id];
      const utteranceToSegment = uid
        ? { ...state.utteranceToSegment, [uid]: next.id }
        : state.utteranceToSegment;
      return { ...state, byId, order, utteranceToSegment };
    }
    default:
      return state;
  }
}

const SPEAKER_DOT_COLORS = [
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-orange-500",
  "bg-cyan-500",
] as const;

function speakerColor(id: number | null): string {
  if (id == null) return "bg-zinc-400";
  return SPEAKER_DOT_COLORS[Math.abs(id) % SPEAKER_DOT_COLORS.length];
}

function speakerLabel(id: number | null): string {
  if (id == null) return "说话人";
  return `Speaker ${id}`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export function LiveShareViewer({
  token,
  initialTitle,
  sourceLang,
  targetLang,
}: LiveShareViewerProps) {
  const [state, dispatch] = React.useReducer(reducer, undefined, () => initial(initialTitle));
  const [connected, setConnected] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const es = new EventSource(`/api/live-share/${encodeURIComponent(token)}`);

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };
    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; we just surface a soft hint.
      setError("连接中断，尝试重连…");
    };

    es.addEventListener("joined", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          session: SessionDTO;
          segments: SegmentDTO[];
        };
        dispatch({ type: "init", session: data.session, segments: data.segments });
      } catch {
        /* ignore parse */
      }
    });

    es.addEventListener("utterance", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          utterance?: Utterance;
        };
        if (data.utterance) dispatch({ type: "utterance", value: data.utterance });
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("segment", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          segment?: SegmentDTO;
          utteranceId?: string;
        };
        if (data.segment) {
          dispatch({
            type: "segment",
            value: data.segment,
            utteranceId: data.utteranceId,
          });
        }
      } catch {
        /* ignore */
      }
    });

    return () => {
      es.close();
    };
  }, [token]);

  // Auto-scroll on new content.
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.order, state.byId]);

  // Sort cards by audio timeline (startMs) — insertion order isn't reliable
  // because in-flight utterances can be added BEFORE earlier utterances finalize
  // into segments.
  const sortedOrder = React.useMemo(() => {
    return [...state.order].sort((a, b) => {
      const ua = state.byId[a];
      const ub = state.byId[b];
      if (!ua || !ub) return 0;
      if (ua.startMs !== ub.startMs) return ua.startMs - ub.startMs;
      // Stable tiebreaker so the live card always falls below its prior twin.
      return a.localeCompare(b);
    });
  }, [state.order, state.byId]);

  // Pick the in-flight (non-final) utterance for highlight — always the last
  // non-final one in time order.
  let liveId: string | null = null;
  for (let i = sortedOrder.length - 1; i >= 0; i--) {
    const u = state.byId[sortedOrder[i]];
    if (u && !u.isFinal) {
      liveId = u.id;
      break;
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50 sm:text-lg">
              {state.title}
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {sourceLang.toUpperCase()} → {targetLang.toUpperCase()} · 只读
            </p>
          </div>
          {connected ? (
            <Badge variant="destructive" className="shrink-0 gap-1.5">
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              Live
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 gap-1.5 text-zinc-500">
              <WifiOff className="h-3.5 w-3.5" />
              离线
            </Badge>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
        {error && !connected ? (
          <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            {error}
          </p>
        ) : null}

        <div
          ref={scrollerRef}
          className="flex max-h-[80vh] flex-col gap-3 overflow-y-auto"
        >
          {sortedOrder.length === 0 ? (
            <div className="flex min-h-[50vh] items-center justify-center rounded-lg border border-zinc-200 bg-white p-12 text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
              正在等待第一句话…
            </div>
          ) : (
            sortedOrder.map((id) => {
              const u = state.byId[id];
              if (!u) return null;
              const isLive = u.id === liveId;
              return (
                <div
                  key={u.id}
                  className={cn(
                    "rounded-lg border p-4 transition-colors",
                    isLive
                      ? "border-rose-300 bg-rose-50/60 shadow-sm ring-1 ring-rose-200 dark:border-rose-800 dark:bg-rose-950/30 dark:ring-rose-900"
                      : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                  )}
                >
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-zinc-500">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn("h-2 w-2 rounded-full", speakerColor(u.speakerId))}
                        aria-hidden
                      />
                      <span>{speakerLabel(u.speakerId)}</span>
                      <span className="text-zinc-300">·</span>
                      <span className="font-mono tabular-nums">
                        {formatElapsed(u.startMs)}
                      </span>
                    </div>
                    {isLive && (
                      <Badge variant="destructive" className="gap-1 px-2 py-0">
                        <Radio className="h-3 w-3 animate-pulse" />
                        LIVE
                      </Badge>
                    )}
                  </div>
                  {u.translatedText ? (
                    <>
                      {u.sourceText ? (
                        <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                          {u.sourceText}
                        </p>
                      ) : null}
                      <p
                        className={cn(
                          "mt-1 leading-relaxed text-zinc-900 dark:text-zinc-50",
                          isLive ? "text-xl font-semibold" : "text-lg font-medium"
                        )}
                      >
                        {u.translatedText}
                      </p>
                    </>
                  ) : u.sourceText ? (
                    // No translation yet — promote source so the card isn't empty.
                    <p
                      className={cn(
                        "leading-relaxed text-zinc-900 dark:text-zinc-50",
                        isLive ? "text-xl font-semibold" : "text-lg font-medium"
                      )}
                    >
                      {u.sourceText}
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </main>
    </div>
  );
}
