"use client";

import * as React from "react";
import { ArrowDown, Radio } from "lucide-react";
import { toast, Toaster } from "sonner";

import { cn } from "@/lib/utils";
import {
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  type SegmentDTO,
  type SessionDTO,
  type SupportedLanguage,
  type Utterance,
} from "@/lib/contracts";
import {
  getOrCreateViewerTranslator,
  hasViewerTranslatorAPI,
  probeViewerTranslator,
} from "@/lib/viewer-translator";
import {
  FONT_SCALE_VALUES,
  type FontScalePreset,
  ViewerToolbar,
} from "@/components/ViewerToolbar";
import { track } from "@/lib/analytics";

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
  /** Translation from host (Soniox cloud or Chrome local). Untouched. */
  translatedText: string;
  /** Viewer's locally re-translated copy of `sourceText`. */
  viewerTranslatedText: string | null;
  isFinal: boolean;
}

type Action =
  | { type: "init"; segments: SegmentDTO[]; session: SessionDTO }
  | { type: "utterance"; value: Utterance }
  | { type: "segment"; value: SegmentDTO; utteranceId?: string }
  | { type: "viewerTranslation"; id: string; sourceText: string; text: string }
  | { type: "clearViewerTranslations" };

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
    viewerTranslatedText: null,
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
    viewerTranslatedText: null,
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

/** When updating an existing slot, preserve the viewer's already-computed
 *  re-translation if the source text didn't change. Avoids flicker on the
 *  growing live card while we wait for the next debounced translate. */
function mergeViewerTranslation(
  prev: DisplayUtterance | undefined,
  next: DisplayUtterance
): DisplayUtterance {
  if (!prev) return next;
  if (!prev.viewerTranslatedText) return next;
  if (prev.sourceText === next.sourceText) {
    return { ...next, viewerTranslatedText: prev.viewerTranslatedText };
  }
  return next;
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
      const incoming = fromUtterance(action.value);
      // 1. Already mapped to a finalized segment slot — route there.
      const mappedSegId = state.utteranceToSegment[incoming.id];
      if (mappedSegId && state.byId[mappedSegId]) {
        const prev = state.byId[mappedSegId];
        const merged = mergeViewerTranslation(prev, {
          ...incoming,
          id: mappedSegId,
        });
        return replaceSlotKey(state, mappedSegId, mappedSegId, merged);
      }
      // 2. Slot already exists under this exact utterance id — update in place.
      if (state.byId[incoming.id]) {
        const prev = state.byId[incoming.id];
        const merged = mergeViewerTranslation(prev, incoming);
        return { ...state, byId: { ...state.byId, [incoming.id]: merged } };
      }
      // 3. Same speaker + similar startMs — merge into the existing slot rather
      //    than appending a duplicate card. (Soniox sometimes re-emits an
      //    utterance under a new id after a sentence split + immediate
      //    re-finalize; without this we get two cards at the same timestamp.)
      const neighborId = findSlotByPosition(
        state,
        incoming.speakerId,
        incoming.startMs
      );
      if (neighborId) {
        // Merge: prefer the longer source text, prefer existing translation if
        // the new one is empty, otherwise take the new one.
        const prev = state.byId[neighborId];
        const merged: DisplayUtterance = {
          id: neighborId,
          speakerId: incoming.speakerId,
          startMs: Math.min(prev.startMs, incoming.startMs),
          sourceText:
            incoming.sourceText.length >= prev.sourceText.length
              ? incoming.sourceText
              : prev.sourceText,
          translatedText:
            incoming.translatedText.length >= prev.translatedText.length
              ? incoming.translatedText
              : prev.translatedText,
          viewerTranslatedText: prev.viewerTranslatedText,
          isFinal: prev.isFinal || incoming.isFinal,
        };
        return { ...state, byId: { ...state.byId, [neighborId]: merged } };
      }
      // 4. Brand new slot.
      return {
        ...state,
        byId: { ...state.byId, [incoming.id]: incoming },
        order: [...state.order, incoming.id],
      };
    }
    case "segment": {
      const next = fromSegment(action.value);
      const uid = action.utteranceId;
      // 1. Segment knows its utterance — swap that slot's key in place.
      if (uid && state.byId[uid]) {
        const prev = state.byId[uid];
        const merged = mergeViewerTranslation(prev, next);
        const ns = replaceSlotKey(state, uid, next.id, merged);
        return {
          ...ns,
          utteranceToSegment: { ...ns.utteranceToSegment, [uid]: next.id },
        };
      }
      // 2. Segment id already known (e.g. PATCH update) — update in place.
      if (state.byId[next.id]) {
        const prev = state.byId[next.id];
        const merged = mergeViewerTranslation(prev, next);
        return { ...state, byId: { ...state.byId, [next.id]: merged } };
      }
      // 3. No mapping but a card already exists at this (speaker, startMs) —
      //    treat it as the same utterance and swap the slot key.
      const neighborId = findSlotByPosition(
        state,
        next.speakerId,
        next.startMs
      );
      if (neighborId) {
        const prev = state.byId[neighborId];
        const merged = mergeViewerTranslation(prev, next);
        const ns = replaceSlotKey(state, neighborId, next.id, merged);
        return uid
          ? {
              ...ns,
              utteranceToSegment: {
                ...ns.utteranceToSegment,
                [uid]: next.id,
              },
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
    case "viewerTranslation": {
      const u = state.byId[action.id];
      if (!u) return state;
      // Only write back if the source text we translated still matches the
      // current source on the card — otherwise we'd splash stale text.
      if (u.sourceText !== action.sourceText) return state;
      if (u.viewerTranslatedText === action.text) return state;
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.id]: { ...u, viewerTranslatedText: action.text },
        },
      };
    }
    case "clearViewerTranslations": {
      const byId: Record<string, DisplayUtterance> = {};
      let changed = false;
      for (const [k, v] of Object.entries(state.byId)) {
        if (v.viewerTranslatedText != null) {
          byId[k] = { ...v, viewerTranslatedText: null };
          changed = true;
        } else {
          byId[k] = v;
        }
      }
      return changed ? { ...state, byId } : state;
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

const THEME_STORAGE_KEY = "lecsync.viewer.theme";
const FONT_SCALE_STORAGE_KEY = "lecsync.viewer.fontScale";

function readInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

function readInitialFontScale(): FontScalePreset {
  if (typeof window === "undefined") return "M";
  try {
    const stored = window.localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    if (stored === "S" || stored === "M" || stored === "L" || stored === "XL") {
      return stored;
    }
  } catch {
    /* ignore */
  }
  return "M";
}

function isSupportedLanguage(v: string): v is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(v);
}

function readInitialViewerLang(fallback: string): SupportedLanguage {
  if (typeof window !== "undefined") {
    try {
      const url = new URL(window.location.href);
      const q = url.searchParams.get("to");
      if (q && isSupportedLanguage(q)) return q;
    } catch {
      /* ignore */
    }
  }
  if (isSupportedLanguage(fallback)) return fallback;
  return "en";
}

/**
 * Lightweight non-cryptographic hash of the share token for analytics
 * grouping. We want "viewers per link" without ever sending the token
 * itself (which is the bearer used to read /api/live-share/{token}).
 * DJB2 — collision-rate is fine at this scale.
 */
function hashToken(token: string): string {
  let h = 5381;
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  }
  // Base36 keeps the value short for the events table — 7 chars is plenty.
  return (h >>> 0).toString(36);
}

const STALE_THRESHOLD_MS = 30_000;

export function LiveShareViewer({
  token,
  initialTitle,
  sourceLang,
  targetLang,
}: LiveShareViewerProps) {
  const [state, dispatch] = React.useReducer(
    reducer,
    undefined,
    () => initial(initialTitle)
  );
  const [connected, setConnected] = React.useState(false);
  const [lastEventAt, setLastEventAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState<number>(() => Date.now());
  // Transport selection: try WebSocket first (lower latency, bidirectional),
  // fall back to the existing EventSource path if WS fails. The SSE branch
  // is the exact same code that shipped before — keeping it intact is the
  // non-breaking guarantee.
  const [transport, setTransport] = React.useState<"ws" | "sse">("ws");

  const [theme, setTheme] = React.useState<"light" | "dark">("light");
  const [fontScale, setFontScale] = React.useState<FontScalePreset>("M");
  const [viewerLang, setViewerLang] = React.useState<SupportedLanguage>(() =>
    readInitialViewerLang(targetLang)
  );
  // When true (default), viewer shows the host's translation verbatim
  // instead of running a parallel local Chrome-Translator pass. This is
  // what makes the host's screen and the share viewer agree. Users who
  // want a different target language can flip the toggle in the toolbar.
  // The `?to=xx` URL param still implies an override → starts with
  // followHost=false because they explicitly asked for a specific lang.
  const [followHost, setFollowHost] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const url = new URL(window.location.href);
      const q = url.searchParams.get("to");
      if (q && isSupportedLanguage(q)) return false;
    } catch {
      /* ignore */
    }
    return true;
  });
  // Tracked separately so we can re-translate every existing card when the
  // host's source language is delivered via the `joined` event.
  const [effectiveSourceLang, setEffectiveSourceLang] =
    React.useState<string>(sourceLang);

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  // Buffers pending translation jobs across renders so we don't fire the
  // same translate() twice for the same (id, sourceText) pair.
  const translatedSeenRef = React.useRef<Map<string, string>>(new Map());

  // -------- hydration: theme / font-scale --------
  React.useEffect(() => {
    setTheme(readInitialTheme());
    setFontScale(readInitialFontScale());
  }, []);

  // Fire-once analytics: someone followed a share link. The viewer is
  // anonymous (no login), so we don't identify() here — PostHog keeps an
  // anonymous distinct_id per browser, which is exactly what we want for
  // "how many distinct viewers per link" funnel questions. We do NOT pass
  // the token through props (it's the bearer for /api/live-share/{token});
  // a hash is enough to group views per link without leaking the secret.
  const sharedOpenedRef = React.useRef(false);
  React.useEffect(() => {
    if (sharedOpenedRef.current) return;
    sharedOpenedRef.current = true;
    track("share_link_opened", {
      role: "viewer",
      tokenHash: hashToken(token),
    });
  }, [token]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, fontScale);
    } catch {
      /* ignore */
    }
  }, [fontScale]);

  // -------- WS feed (preferred) with SSE fallback --------
  // Route a single payload (already-parsed JSON) into the same reducer
  // actions the SSE branch uses. Kept out of the effect so both transports
  // dispatch through identical logic.
  const routePayload = React.useCallback(
    (data: {
      type?: string;
      session?: SessionDTO;
      segments?: SegmentDTO[];
      utterance?: Utterance;
      segment?: SegmentDTO;
      utteranceId?: string;
    }) => {
      switch (data.type) {
        case "joined": {
          if (data.session && Array.isArray(data.segments)) {
            dispatch({
              type: "init",
              session: data.session,
              segments: data.segments,
            });
            if (data.session.sourceLang) {
              setEffectiveSourceLang(data.session.sourceLang);
            }
          }
          break;
        }
        case "utterance": {
          if (data.utterance) {
            dispatch({ type: "utterance", value: data.utterance });
          }
          break;
        }
        case "segment": {
          if (data.segment) {
            dispatch({
              type: "segment",
              value: data.segment,
              utteranceId: data.utteranceId,
            });
          }
          break;
        }
        // session-status / viewerCount are WS-only sidecar messages —
        // the UI doesn't read them yet, so we just bump activity above.
        default:
          break;
      }
    },
    []
  );

  // -------- WebSocket branch --------
  React.useEffect(() => {
    if (transport !== "ws") return;
    if (typeof window === "undefined") return;
    if (typeof WebSocket === "undefined") {
      // Older runtime: skip straight to SSE.
      setTransport("sse");
      return;
    }

    let ws: WebSocket | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    // Was the socket ever observed in OPEN state? Distinguishes
    // "never connected (→ fall back to SSE immediately)" from
    // "was connected then dropped (→ exponential-retry then fall back)".
    let everOpen = false;

    const RETRY_DELAYS_MS = [500, 1500, 3000];

    const bump = () => setLastEventAt(Date.now());

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${proto}://${window.location.host}/ws/live/${encodeURIComponent(token)}?role=viewer`;
      let next: WebSocket;
      try {
        next = new WebSocket(url);
      } catch {
        // Construction itself threw (bad URL, blocked by policy, etc.).
        setTransport("sse");
        return;
      }
      ws = next;

      next.onopen = () => {
        if (cancelled) return;
        everOpen = true;
        attempt = 0;
        setConnected(true);
      };

      next.onmessage = (e: MessageEvent) => {
        if (cancelled) return;
        bump();
        try {
          const data = JSON.parse(e.data);
          routePayload(data);
        } catch {
          /* ignore parse */
        }
      };

      next.onerror = () => {
        // Browsers fire onerror just before onclose for failed handshakes.
        // We let onclose drive the actual transport flip / retry decision
        // — it has access to whether we ever reached OPEN state. Trying
        // to flip transport here would race with onclose's cleanup.
      };

      next.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        ws = null;
        if (!everOpen) {
          // Never connected — give up on WS, use SSE.
          setTransport("sse");
          return;
        }
        // Was connected at least once: retry with exponential backoff,
        // then fall back to SSE if all retries fail.
        if (attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt];
          attempt += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
          }, delay);
        } else {
          setTransport("sse");
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer != null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    };
  }, [token, transport, routePayload]);

  // -------- SSE fallback feed --------
  React.useEffect(() => {
    if (transport !== "sse") return;
    const es = new EventSource(`/api/live-share/${encodeURIComponent(token)}`);

    const bump = () => setLastEventAt(Date.now());

    es.onopen = () => {
      setConnected(true);
    };
    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; we just surface "disconnected" state.
    };

    es.addEventListener("joined", (ev) => {
      bump();
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          session: SessionDTO;
          segments: SegmentDTO[];
        };
        dispatch({
          type: "init",
          session: data.session,
          segments: data.segments,
        });
        // Adopt the host's source language so re-translation knows the FROM
        // direction even if the page prop disagrees.
        if (data.session.sourceLang) {
          setEffectiveSourceLang(data.session.sourceLang);
        }
      } catch {
        /* ignore parse */
      }
    });

    es.addEventListener("utterance", (ev) => {
      bump();
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          utterance?: Utterance;
        };
        if (data.utterance) {
          dispatch({ type: "utterance", value: data.utterance });
        }
      } catch {
        /* ignore */
      }
    });

    es.addEventListener("segment", (ev) => {
      bump();
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
  }, [token, transport]);

  // 1Hz tick so the staleness label updates without an SSE event.
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Note: there used to be a 30s segments-reconcile poll here as a safety
  // net for dropped SSE events, but for a live-subtitle product 30 s is
  // unusable — by the time a missed line appears the conversation has
  // moved on. The viewer now relies entirely on the host's push (with
  // 1× retry on the recorder side) + the SSE feed. If anything is lost,
  // it's lost; nginx buffering + push retry are where reliability is
  // actually fought. See docs/LIVE_SHARE_OPS.md.

  // -------- viewer-side re-translation --------
  // When the viewer changes language OR re-enables follow-host: wipe
  // per-card viewer translations so the host's translation is shown
  // momentarily, then (if follow-host is off) we re-translate every card
  // under the new pair.
  React.useEffect(() => {
    dispatch({ type: "clearViewerTranslations" });
    translatedSeenRef.current = new Map();
  }, [viewerLang, followHost]);

  // Pick which card's source text to re-translate: anything whose viewer
  // translation we haven't computed yet under the current pair.
  React.useEffect(() => {
    // The default branch: viewer follows the host's translation. This is
    // what makes the two screens agree — the prior behaviour kicked off
    // an independent Chrome Translator pass for every card and produced
    // visibly different wording from the host's translation.
    if (followHost) {
      return;
    }
    if (viewerLang === effectiveSourceLang) {
      // Same language — host source IS the translation. Nothing to do.
      return;
    }
    if (!hasViewerTranslatorAPI()) {
      return;
    }
    let cancelled = false;

    const runOnce = async () => {
      const translator = await getOrCreateViewerTranslator(
        effectiveSourceLang,
        viewerLang
      );
      if (cancelled) return;
      if (!translator) {
        // Probe to give a more specific toast — "downloadable" vs missing API.
        const a = await probeViewerTranslator(effectiveSourceLang, viewerLang);
        if (cancelled) return;
        if (a === "downloadable") {
          toast.error(
            `本地翻译模型未安装：${effectiveSourceLang.toUpperCase()} → ${viewerLang.toUpperCase()}，已保留主持人翻译`
          );
        } else if (a === "unavailable" || a == null) {
          toast.error(
            `本地翻译不可用，已保留主持人翻译（需要 Chrome 138+ 并启用 Translator API）`
          );
        } else {
          toast.error("本地翻译初始化失败，已保留主持人翻译");
        }
        return;
      }

      // Translate every card whose current source text we haven't translated
      // yet under this pair. Sequential to keep CPU/IO modest.
      const seen = translatedSeenRef.current;
      for (const id of state.order) {
        if (cancelled) return;
        const u = state.byId[id];
        if (!u) continue;
        const src = u.sourceText;
        if (!src) continue;
        // Key by (id + sourceText) so growing live cards re-translate as text
        // accumulates, but a static finalized card translates exactly once.
        const key = `${id}|${src}`;
        if (seen.get(id) === key) continue;
        try {
          const translated = await translator.translate(src);
          if (cancelled) return;
          seen.set(id, key);
          dispatch({
            type: "viewerTranslation",
            id,
            sourceText: src,
            text: translated,
          });
        } catch {
          // Single-card failure — skip and try the next. The cache will
          // re-attempt automatically on the next render tick.
        }
      }
    };

    void runOnce();
    return () => {
      cancelled = true;
    };
    // Re-run whenever the source map changes — new cards arrive, live card
    // text grows, etc. The `seen` map debounces inside the loop.
  }, [viewerLang, effectiveSourceLang, state.order, state.byId, followHost]);

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

  // Auto-scroll on new content — but only when the viewer is already
  // pinned to the bottom. Without the scroll-lock detection every
  // incoming utterance / segment yanked the view back down, so the
  // viewer couldn't read history during a live session (user reported
  // "无论是跟随主持人还是不跟随，都没法查看历史记录"). Mirrors the
  // host-side UtteranceList scroll-lock pattern.
  const pinnedRef = React.useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = React.useState(false);

  // rAF-throttled scroll listener so the pinned flag tracks the user's
  // intent without firing setState on every scroll tick.
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf: number | null = null;
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        const nextPinned = dist < 64;
        if (nextPinned !== pinnedRef.current) {
          pinnedRef.current = nextPinned;
          setShowJumpToBottom(!nextPinned);
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  React.useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [sortedOrder, state.byId]);

  const handleJumpToBottom = React.useCallback(() => {
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    const el = scrollerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, []);

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

  // -------- status indicator --------
  const ageMs =
    lastEventAt == null ? null : Math.max(0, now - lastEventAt);
  let statusTone: "live" | "paused" | "disconnected";
  let statusLabel: string;
  if (!connected) {
    statusTone = "disconnected";
    statusLabel = "断开连接 · 重连中…";
  } else if (ageMs == null || ageMs < STALE_THRESHOLD_MS) {
    statusTone = "live";
    statusLabel = "Live · 主持人正在录制";
  } else {
    statusTone = "paused";
    statusLabel = "已暂停";
  }

  // -------- export actions --------
  const buildExportRows = React.useCallback(() => {
    return sortedOrder
      .map((id) => state.byId[id])
      .filter((u): u is DisplayUtterance => !!u)
      .map((u) => ({
        source: u.sourceText,
        // Follow-host mode exports the host's translation; override mode
        // exports the viewer's local re-translation when available.
        target: followHost
          ? u.translatedText
          : (u.viewerTranslatedText ?? u.translatedText),
      }))
      .filter((row) => row.source || row.target);
  }, [sortedOrder, state.byId, followHost]);

  const handleCopyAll = React.useCallback(() => {
    const rows = buildExportRows();
    const text = rows.map((r) => `${r.source}\t${r.target}`).join("\n");
    if (!text) {
      toast.error("还没有可复制的内容");
      return;
    }
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      navigator.clipboard
        .writeText(text)
        .then(() => toast.success("已复制全部转录"))
        .catch(() => toast.error("复制失败，请检查浏览器权限"));
    } else {
      toast.error("当前浏览器不支持剪贴板写入");
    }
  }, [buildExportRows]);

  const handleDownloadMd = React.useCallback(() => {
    const rows = buildExportRows();
    if (rows.length === 0) {
      toast.error("还没有可下载的内容");
      return;
    }
    const title = state.title || "实时分享";
    const body = rows.map((r) => `${r.source}\n${r.target}`).join("\n\n");
    const md = `# ${title}\n\n## Transcript\n\n${body}\n`;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${token}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give the browser a tick to actually start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [buildExportRows, state.title, token]);

  // -------- font scaling --------
  const scale = FONT_SCALE_VALUES[fontScale];
  const sourceFontPx = 14 * scale;
  const liveTargetFontPx = 20 * scale;
  const finalTargetFontPx = 18 * scale;

  return (
    <div
      ref={wrapperRef}
      className={cn(theme === "dark" ? "dark" : undefined)}
    >
      <Toaster
        position="top-center"
        theme={theme}
        richColors
        closeButton
      />
      <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
          <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-3 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50 sm:text-lg">
                  {state.title}
                </h1>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {effectiveSourceLang.toUpperCase()} →{" "}
                  {followHost
                    ? `${targetLang.toUpperCase()}（跟随主持人）`
                    : (LANGUAGE_NAMES[viewerLang] ?? viewerLang.toUpperCase())}{" "}
                  · 只读
                </p>
              </div>
            </div>
            <ViewerToolbar
              statusLabel={statusLabel}
              statusTone={statusTone}
              viewerLang={viewerLang}
              onViewerLangChange={setViewerLang}
              followHost={followHost}
              onFollowHostChange={setFollowHost}
              fontScale={fontScale}
              onFontScaleChange={setFontScale}
              theme={theme}
              onThemeToggle={() =>
                setTheme((t) => (t === "dark" ? "light" : "dark"))
              }
              onCopyAll={handleCopyAll}
              onDownloadMd={handleDownloadMd}
            />
          </div>
        </header>

        <main className="relative mx-auto max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
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
                // Follow-host: show the host's translation verbatim so
                // both screens agree. Override: show viewer's local
                // re-translation when available, otherwise fall back to
                // host's so the user never sees an empty card.
                const targetText = followHost
                  ? u.translatedText
                  : (u.viewerTranslatedText ?? u.translatedText);
                const targetFontPx = isLive
                  ? liveTargetFontPx
                  : finalTargetFontPx;
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
                          className={cn(
                            "h-2 w-2 rounded-full",
                            speakerColor(u.speakerId)
                          )}
                          aria-hidden
                        />
                        <span>{speakerLabel(u.speakerId)}</span>
                        <span className="text-zinc-300">·</span>
                        <span className="font-mono tabular-nums">
                          {formatElapsed(u.startMs)}
                        </span>
                      </div>
                      {isLive && (
                        <span className="inline-flex items-center gap-1 rounded bg-rose-600 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white">
                          <Radio className="h-3 w-3 animate-pulse" />
                          LIVE
                        </span>
                      )}
                    </div>
                    {targetText ? (
                      <>
                        {u.sourceText ? (
                          <p
                            className="leading-relaxed text-zinc-500 dark:text-zinc-400"
                            style={{ fontSize: `${sourceFontPx}px` }}
                          >
                            {u.sourceText}
                          </p>
                        ) : null}
                        <p
                          className={cn(
                            "mt-1 leading-relaxed text-zinc-900 dark:text-zinc-50",
                            isLive ? "font-semibold" : "font-medium"
                          )}
                          style={{ fontSize: `${targetFontPx}px` }}
                        >
                          {targetText}
                        </p>
                      </>
                    ) : u.sourceText ? (
                      // No translation yet — promote source so the card isn't empty.
                      <p
                        className={cn(
                          "leading-relaxed text-zinc-900 dark:text-zinc-50",
                          isLive ? "font-semibold" : "font-medium"
                        )}
                        style={{ fontSize: `${targetFontPx}px` }}
                      >
                        {u.sourceText}
                      </p>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          {showJumpToBottom ? (
            <button
              type="button"
              onClick={handleJumpToBottom}
              className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-md backdrop-blur transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800 sm:bottom-6 sm:right-6"
              aria-label="回到最新"
            >
              <ArrowDown className="h-3 w-3" aria-hidden />
              回到最新
            </button>
          ) : null}
        </main>
      </div>
    </div>
  );
}
