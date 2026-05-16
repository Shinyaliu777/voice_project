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
  | { type: "segment"; value: SegmentDTO };

interface State {
  title: string;
  order: string[];
  byId: Record<string, DisplayUtterance>;
}

function initial(initialTitle: string): State {
  return { title: initialTitle, order: [], byId: {} };
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
      };
    }
    case "utterance": {
      const next = fromUtterance(action.value);
      const existing = state.byId[next.id];
      const byId = { ...state.byId, [next.id]: next };
      const order = existing ? state.order : [...state.order, next.id];
      return { ...state, byId, order };
    }
    case "segment": {
      const next = fromSegment(action.value);
      const byId = { ...state.byId, [next.id]: next };
      const order = state.byId[next.id] ? state.order : [...state.order, next.id];
      return { ...state, byId, order };
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
        };
        if (data.segment) dispatch({ type: "segment", value: data.segment });
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
  }, [state.order.length, state.byId]);

  // Pick the in-flight (non-final) utterance for highlight.
  let liveId: string | null = null;
  for (let i = state.order.length - 1; i >= 0; i--) {
    const u = state.byId[state.order[i]];
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
          {state.order.length === 0 ? (
            <div className="flex min-h-[50vh] items-center justify-center rounded-lg border border-zinc-200 bg-white p-12 text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
              正在等待第一句话…
            </div>
          ) : (
            state.order.map((id) => {
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
                  {u.sourceText ? (
                    <p
                      className={cn(
                        "text-base leading-relaxed text-zinc-900 dark:text-zinc-100",
                        isLive && "font-medium"
                      )}
                    >
                      {u.sourceText}
                    </p>
                  ) : null}
                  {u.translatedText ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                      {u.translatedText}
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
