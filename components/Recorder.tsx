"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowLeftRight,
  Loader2,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Share2,
  Square,
  Upload,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { LanguagePicker } from "@/components/LanguagePicker";
import { AudioSourcePicker } from "@/components/AudioSourcePicker";
import { TranslationModePicker } from "@/components/TranslationModePicker";
import { LocalTranslatorDialog } from "@/components/LocalTranslatorDialog";
import { BookmarkInRecording } from "@/components/BookmarkInRecording";
import { FloatingSubtitleToggle } from "@/components/FloatingSubtitleToggle";
import { LiveShareDialog } from "@/components/LiveShareDialog";
import { MinutesView } from "@/components/MinutesView";
import { RecorderSidebar } from "@/components/RecorderSidebar";
import { isChromeTranslatorAvailable } from "@/lib/translation/chrome-local";
import { Recorder as AudioRecorder } from "@/lib/audio/recorder";
import type {
  AudioSource,
  MinutesSection,
  MinutesStreamEvent,
  RecorderEvent,
  RecorderState,
  SessionDTO,
  SonioxTokenResponse,
  TranslationMode,
  Utterance,
} from "@/lib/contracts";

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

type DisplayMode = "balanced" | "source-emphasis" | "translation-emphasis";

const DISPLAY_MODE_LABEL: Record<DisplayMode, string> = {
  balanced: "平衡",
  "source-emphasis": "原文优先",
  "translation-emphasis": "译文优先",
};

interface LiveState {
  status: RecorderState;
  level: number;
  startedAt: number | null;
  order: string[];
  byId: Record<string, Utterance>;
}

type Action =
  | { type: "reset" }
  | { type: "started"; at: number }
  | { type: "state"; value: RecorderState }
  | { type: "level"; value: number }
  | { type: "utterance"; value: Utterance };

function initialState(): LiveState {
  return {
    status: "idle",
    level: 0,
    startedAt: null,
    order: [],
    byId: {},
  };
}

function reducer(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "reset":
      return initialState();
    case "started":
      return { ...state, status: "recording", startedAt: action.at };
    case "state":
      return { ...state, status: action.value };
    case "level":
      return { ...state, level: action.value };
    case "utterance": {
      const u = action.value;
      const existing = state.byId[u.id];
      const byId = { ...state.byId, [u.id]: u };
      const order = existing ? state.order : [...state.order, u.id];
      return { ...state, byId, order };
    }
    default:
      return state;
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
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

function speakerColor(speakerId: number | undefined): string {
  if (speakerId == null) return "bg-zinc-400";
  return SPEAKER_DOT_COLORS[Math.abs(speakerId) % SPEAKER_DOT_COLORS.length];
}

function speakerLabel(speakerId: number | undefined): string {
  if (speakerId == null) return "说话人";
  return `Speaker ${speakerId}`;
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export interface RecorderComponentProps {
  defaultSourceLang?: string;
  defaultTargetLang?: string;
  defaultAudioSource?: AudioSource;
  defaultTitle?: string;
  onSessionCreated?: (session: SessionDTO) => void;
}

export function Recorder({
  defaultSourceLang = "en",
  defaultTargetLang = "zh",
  defaultAudioSource = "microphone",
  defaultTitle,
  onSessionCreated,
}: RecorderComponentProps) {
  const router = useRouter();

  const [audioSource, setAudioSource] = React.useState<AudioSource>(defaultAudioSource);
  const [sourceLang, setSourceLang] = React.useState(defaultSourceLang);
  const [targetLang, setTargetLang] = React.useState(defaultTargetLang);
  // Default to "local" = Chrome's on-device Translator API. No Soniox
  // translation budget used; works the moment the language model is
  // downloaded. The picker auto-falls-back to "cloud" if Chrome's API
  // isn't available (see effect below).
  const [translationMode, setTranslationMode] = React.useState<TranslationMode>("local");
  const [localSetupOpen, setLocalSetupOpen] = React.useState(false);

  // Intercept "local" picks: probe Chrome's Translator API first. If the
  // language pair is ready, switch immediately. If the model is downloadable
  // or the API is missing, open the setup dialog so the user can either
  // download the model in one click or fall back to cloud.
  const handleTranslationModeChange = React.useCallback(
    async (next: TranslationMode) => {
      if (next !== "local") {
        setTranslationMode(next);
        return;
      }
      const T =
        typeof window === "undefined"
          ? null
          : (
              window as unknown as {
                Translator?: {
                  availability(opts: {
                    sourceLanguage: string;
                    targetLanguage: string;
                  }): Promise<string>;
                };
              }
            ).Translator ?? null;
      if (!T) {
        setLocalSetupOpen(true);
        return;
      }
      try {
        const a = await T.availability({
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
        });
        if (a === "available") {
          setTranslationMode("local");
        } else {
          setLocalSetupOpen(true);
        }
      } catch {
        setLocalSetupOpen(true);
      }
    },
    [sourceLang, targetLang]
  );
  const [displayMode, setDisplayMode] = React.useState<DisplayMode>("translation-emphasis");

  const swapLanguages = React.useCallback(() => {
    setSourceLang((prevSource) => {
      const newSource = targetLang;
      setTargetLang(prevSource);
      return newSource;
    });
  }, [targetLang]);
  const [starting, setStarting] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  const [state, dispatch] = React.useReducer(reducer, undefined, initialState);
  const recorderRef = React.useRef<AudioRecorder | null>(null);
  const [nowTs, setNowTs] = React.useState(0);
  const [liveShareOpen, setLiveShareOpen] = React.useState(false);

  const [stopConfirmOpen, setStopConfirmOpen] = React.useState(false);

  // Two-tier minutes state (mirrors lecsync):
  //   - confirmedSections: locked-in chapters, won't change anymore
  //   - pendingSection: current chapter, may grow with new bullets
  //   - minutesSections (derived): the flat array passed to <MinutesView>
  const [confirmedSections, setConfirmedSections] = React.useState<MinutesSection[]>([]);
  const [pendingSection, setPendingSection] = React.useState<MinutesSection | null>(null);
  const minutesSections = React.useMemo<MinutesSection[]>(
    () => (pendingSection ? [...confirmedSections, pendingSection] : confirmedSections),
    [confirmedSections, pendingSection]
  );
  const [minutesStatus, setMinutesStatus] = React.useState<"idle" | "streaming" | "error">("idle");
  const minutesAbortRef = React.useRef<AbortController | null>(null);
  // Tracks which utterance ids have already been sent in a minutes delta —
  // we recompute "newTranscripts" by filtering against this set.
  const minutesSentIdsRef = React.useRef<Set<string>>(new Set());
  // Bookkeeping for the auto-refresh effect — see the effect below.
  const lastMinutesRefreshAtRef = React.useRef<number>(0);
  const lastMinutesFinalCountRef = React.useRef<number>(0);

  // Decide initial translation mode based on Chrome availability.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const available = await isChromeTranslatorAvailable();
        if (alive && !available) setTranslationMode("cloud");
      } catch {
        if (alive) setTranslationMode("cloud");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Ticker for elapsed timer while recording.
  React.useEffect(() => {
    if (state.status !== "recording" || state.startedAt == null) return;
    const handle = window.setInterval(() => setNowTs(Date.now()), 250);
    return () => window.clearInterval(handle);
  }, [state.status, state.startedAt]);

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      const rec = recorderRef.current;
      if (rec) {
        rec.stop().catch(() => {});
        recorderRef.current = null;
      }
      minutesAbortRef.current?.abort();
    };
  }, []);

  const handleEvent = React.useCallback((event: RecorderEvent) => {
    if (event.state) dispatch({ type: "state", value: event.state });
    if (typeof event.level === "number") dispatch({ type: "level", value: event.level });
    if (event.utterance) {
      dispatch({ type: "utterance", value: event.utterance });
    }
    if (event.error) {
      // Some "errors" are actually recovery-success info events — route those
      // to a green toast so the user understands recording is fine again.
      const code = event.error.code;
      const msg = event.error.message || "Recorder error";
      if (code === "device_recovered" || code === "ws_recovered") {
        toast.success(msg);
      } else if (code === "device_disconnected") {
        toast.warning(msg);
      } else {
        toast.error(msg);
      }
    }
  }, []);

  const startRecording = React.useCallback(async () => {
    if (starting || state.status === "recording") return;
    setStarting(true);
    setConfirmedSections([]);
    setPendingSection(null);
    setMinutesStatus("idle");
    try {
      const title = defaultTitle ?? new Date().toLocaleString();
      const sessionResp = await fetch("/api/transcription/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sourceLang, targetLang }),
      });
      if (!sessionResp.ok) throw new Error(`Failed to create session (${sessionResp.status})`);
      const session = (await sessionResp.json()) as SessionDTO;
      setSessionId(session.id);
      onSessionCreated?.(session);

      const tokenResp = await fetch("/api/soniox-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!tokenResp.ok) throw new Error(`Failed to mint token (${tokenResp.status})`);
      const token = (await tokenResp.json()) as SonioxTokenResponse;

      const rec = new AudioRecorder(
        {
          sessionId: session.id,
          sonioxToken: token.token,
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
          translationMode,
          audioSource,
        },
        handleEvent
      );

      recorderRef.current = rec;
      await rec.start();
      dispatch({ type: "started", at: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not start recording";
      toast.error(msg);
      const rec = recorderRef.current;
      if (rec) {
        await rec.stop().catch(() => {});
        recorderRef.current = null;
      }
      dispatch({ type: "reset" });
    } finally {
      setStarting(false);
    }
  }, [
    starting,
    state.status,
    defaultTitle,
    sourceLang,
    targetLang,
    translationMode,
    audioSource,
    handleEvent,
    onSessionCreated,
  ]);

  const stopRecording = React.useCallback(async () => {
    const rec = recorderRef.current;
    const id = sessionId;
    minutesAbortRef.current?.abort();
    try {
      if (rec) await rec.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stop failed";
      toast.error(msg);
    } finally {
      recorderRef.current = null;
      dispatch({ type: "reset" });
      if (id) router.push(`/dashboard/history/${id}`);
    }
  }, [sessionId, router]);

  const refreshLiveMinutes = React.useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!sessionId || minutesStatus === "streaming") return;
      const silent = opts?.silent === true;

      // Compute the delta — finalized utterances not yet sent in any prior
      // minutes call.
      const sent = minutesSentIdsRef.current;
      const newTranscripts: Array<{
        segmentId: string;
        text: string;
        timestamp: number;
      }> = [];
      const justSentIds: string[] = [];
      const startedAt = state.startedAt ?? Date.now();
      for (const id of state.order) {
        const u = state.byId[id];
        if (!u?.isFinal) continue;
        if (sent.has(u.id)) continue;
        const text = u.sourceText.trim();
        if (text.length < 3) {
          // skip but mark as sent so we don't reconsider it later
          justSentIds.push(u.id);
          continue;
        }
        newTranscripts.push({
          segmentId: u.id,
          text,
          timestamp: Math.max(0, u.startMs),
        });
        justSentIds.push(u.id);
      }
      // No new content → don't burn a call.
      if (newTranscripts.length === 0) return;

      minutesAbortRef.current?.abort();
      const ctrl = new AbortController();
      minutesAbortRef.current = ctrl;
      setMinutesStatus("streaming");

      try {
        const resp = await fetch(`/api/sessions/${sessionId}/minutes/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "incremental",
            confirmedSections: confirmedSections.map((s) => ({
              title: s.title,
              narrative: s.narrative,
              points: s.points,
              timeStartMs: s.timeStartMs,
              timeEndMs: s.timeEndMs,
            })),
            pendingSection: pendingSection
              ? {
                  title: pendingSection.title,
                  narrative: pendingSection.narrative,
                  points: pendingSection.points,
                  timeStartMs: pendingSection.timeStartMs,
                  timeEndMs: pendingSection.timeEndMs,
                }
              : null,
            newTranscripts,
            language: targetLang,
          }),
          signal: ctrl.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`Failed to stream minutes (${resp.status})`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let appliedUpdate = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const evt of events) {
            const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            let payload: MinutesStreamEvent;
            try {
              payload = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if (payload.type === "incremental_update") {
              const { topicChanged, currentTopic } = payload.update;
              // Mark the delta as consumed only AFTER a successful update so
              // a network error doesn't drop transcripts.
              for (const id of justSentIds) sent.add(id);

              // New shape prefers `newNarrative` (prose increment). Old
              // bullet shape (`newPoints`) is kept as a fallback so a stale
              // server still works.
              const newNarrative = (currentTopic.newNarrative ?? "").trim();
              const hasNarrativeDelta = newNarrative.length > 0;

              if (topicChanged && pendingSection) {
                // Lock the prior pending section into confirmed, start fresh.
                setConfirmedSections((prev) => [...prev, pendingSection]);
                setPendingSection({
                  title: currentTopic.title || "新话题",
                  narrative: hasNarrativeDelta ? newNarrative : undefined,
                  points: hasNarrativeDelta ? [] : currentTopic.newPoints,
                  timeStartMs: currentTopic.timeStartMs,
                  timeEndMs: currentTopic.timeEndMs,
                });
              } else if (pendingSection) {
                // Append new prose to the running narrative — paragraph break
                // between updates so the LLM's incremental drafts stay readable.
                const prevNarrative = pendingSection.narrative ?? "";
                const mergedNarrative = hasNarrativeDelta
                  ? (prevNarrative ? `${prevNarrative}\n\n${newNarrative}` : newNarrative)
                  : prevNarrative || undefined;
                setPendingSection({
                  title: currentTopic.title || pendingSection.title,
                  narrative: mergedNarrative,
                  points: hasNarrativeDelta
                    ? pendingSection.points
                    : [...pendingSection.points, ...currentTopic.newPoints],
                  timeStartMs: pendingSection.timeStartMs ?? currentTopic.timeStartMs,
                  timeEndMs: currentTopic.timeEndMs ?? pendingSection.timeEndMs,
                });
              } else {
                // First refresh of the session — open a pending section.
                setPendingSection({
                  title: currentTopic.title || "话题 1",
                  narrative: hasNarrativeDelta ? newNarrative : undefined,
                  points: hasNarrativeDelta ? [] : currentTopic.newPoints,
                  timeStartMs: currentTopic.timeStartMs ?? Math.max(0, Date.now() - startedAt),
                  timeEndMs: currentTopic.timeEndMs,
                });
              }
              appliedUpdate = true;
            } else if (payload.type === "error") {
              throw new Error(payload.message);
            }
          }
        }
        if (!appliedUpdate) {
          // Server returned no update at all — treat delta as consumed
          // (probably all-filler content the model skipped).
          for (const id of justSentIds) sent.add(id);
        }
        setMinutesStatus("idle");
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setMinutesStatus("error");
        // Auto-refresh failures (LLM quota etc.) shouldn't spam toasts — the
        // user didn't ask for this run. Manual clicks still get the toast.
        if (!silent) {
          toast.error(err instanceof Error ? err.message : "纪要生成失败");
        }
      }
    },
    [
      sessionId,
      targetLang,
      minutesStatus,
      state.byId,
      state.order,
      state.startedAt,
      confirmedSections,
      pendingSection,
    ]
  );

  // Auto-refresh "实时纪要" while recording. Matched to lecsync's actual
  // trigger logic (extracted from their bundle):
  //   minCharactersForUpdate: 2000
  //   onFinalTranscript: append to buffer; if accumulated NEW-text length
  //   ≥ 2000 chars AND not already streaming → triggerSummaryUpdate().
  //
  // Skip utterances with trim().length < 3 (filler "啊"/"嗯"/etc.). The
  // accumulated count resets to 0 after each successful refresh.
  //
  // This is purely content-volume driven, not clock-driven — naturally
  // produces uneven refresh intervals depending on speech density.
  const lastMinutesCharsRef = React.useRef<number>(0);
  React.useEffect(() => {
    if (state.status !== "recording") return;
    if (minutesStatus === "streaming") return;
    if (!sessionId) return;

    let finalCount = 0;
    let totalChars = 0;
    for (const id of state.order) {
      const u = state.byId[id];
      if (!u?.isFinal) continue;
      finalCount++;
      const t = u.sourceText.trim();
      if (t.length >= 3) totalChars += t.length;
    }
    const newChars = totalChars - lastMinutesCharsRef.current;
    if (newChars < 2000) return;

    lastMinutesCharsRef.current = totalChars;
    lastMinutesFinalCountRef.current = finalCount;
    lastMinutesRefreshAtRef.current = Date.now();
    void refreshLiveMinutes({ silent: true });
  }, [state.status, state.byId, state.order, sessionId, minutesStatus, refreshLiveMinutes]);

  // Reset auto-refresh bookkeeping each time recording (re)starts so a new
  // session doesn't inherit the previous session's accumulated counters
  // or pending section.
  React.useEffect(() => {
    if (state.status === "recording" && state.startedAt != null) {
      lastMinutesRefreshAtRef.current = 0;
      lastMinutesFinalCountRef.current = 0;
      lastMinutesCharsRef.current = 0;
      minutesSentIdsRef.current = new Set();
      setConfirmedSections([]);
      setPendingSection(null);
    }
  }, [state.status, state.startedAt]);

  const elapsedMs =
    state.startedAt != null && nowTs > 0 ? Math.max(0, nowTs - state.startedAt) : 0;
  const elapsedRef = React.useRef(elapsedMs);
  elapsedRef.current = elapsedMs;
  const getCurrentMs = React.useCallback(() => elapsedRef.current, []);

  // Scrolling history for the floating subtitle window. We send a much
  // longer tail than what's visible at once — the PiP window has its
  // own overflow-y scroller, and at the previous slice(-6) the window
  // looked nearly empty no matter how tall the user dragged it (user
  // reported "再大也就那么几行"). 50 items covers a multi-minute
  // teleprompter view; FloatingSubtitleWindow CSS pins to the bottom
  // and the scroller handles overflow.
  //
  // Order by audio startMs so multi-speaker turns render in the order
  // the speech actually happened. Soniox emits per-speaker utterances
  // interleaved (Speaker-1's u4 can land in state.order BEFORE
  // Speaker-2's u3 even though u3 started earlier on the audio
  // timeline), and the prior insertion-order pass produced the
  // "句子顺序还是不对" the user reported for two-speaker dialogue.
  const orderedIds = React.useMemo(() => {
    return [...state.order].sort((a, b) => {
      const ua = state.byId[a];
      const ub = state.byId[b];
      if (!ua || !ub) return 0;
      if (ua.startMs !== ub.startMs) return ua.startMs - ub.startMs;
      // Stable tiebreaker so the LIVE card always falls below its prior
      // twin within the same startMs bucket.
      return a.localeCompare(b);
    });
  }, [state.order, state.byId]);

  const floatingItems = React.useMemo(() => {
    const tail = orderedIds.slice(-50);
    return tail
      .map((id) => state.byId[id])
      .filter(Boolean)
      .map((u, idx, arr) => ({
        id: u.id,
        sourceText: u.sourceText,
        translatedText: u.translatedText ?? "",
        isLive: !u.isFinal && idx === arr.length - 1,
      }));
  }, [orderedIds, state.byId]);

  const showTranslation = translationMode !== "off";
  const recording = state.status === "recording";

  // Split the utterance stream into "history" (finalized) and the single
  // in-flight one that powers the bottom LIVE card. Lecsync renders these
  // as distinct regions — transcript at top, LIVE card clustered with the
  // transport pill at the bottom — so we lift the split out of UtteranceList
  // and place LiveCard as its own sibling further down.
  const { liveUtterance, finalIds, multiSpeaker } = React.useMemo(() => {
    // The live utterance is the most recently emitted non-final one.
    // Use insertion order here, NOT startMs — when two speakers talk
    // simultaneously we want the freshest "still-typing" card to power
    // the LIVE block, not the one that started earliest on the audio
    // timeline.
    let liveId: string | null = null;
    for (let i = state.order.length - 1; i >= 0; i--) {
      const u = state.byId[state.order[i]];
      if (u && !u.isFinal) {
        liveId = u.id;
        break;
      }
    }
    // Transcript history is rendered top-to-bottom in audio-timeline
    // order. orderedIds is the startMs-sorted view used elsewhere; we
    // filter the live id out so it doesn't double-render (LiveCard
    // already shows it as the bottom sticky block).
    const finals = liveId
      ? orderedIds.filter((id) => id !== liveId)
      : orderedIds;
    const live = liveId ? state.byId[liveId] ?? null : null;
    const speakers = new Set<number>();
    for (const id of finals) {
      const u = state.byId[id];
      if (u?.speakerId != null) speakers.add(u.speakerId);
    }
    if (live?.speakerId != null) speakers.add(live.speakerId);
    return {
      liveUtterance: live,
      finalIds: finals,
      multiSpeaker: speakers.size > 1,
    };
  }, [state.order, state.byId, orderedIds]);

  const hasHistory = finalIds.length > 0;
  const showLiveCard = liveUtterance !== null || recording;

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  if (state.status === "idle") {
    return (
      <div className="flex w-full flex-col">
        {/* Top controls — audio source / language pair / translation mode */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <AudioSourcePicker value={audioSource} onChange={setAudioSource} />
          <LanguagePicker
            value={sourceLang}
            onChange={setSourceLang}
            ariaLabel="源语言"
          />
          <button
            type="button"
            onClick={swapLanguages}
            aria-label="对调源语言与目标语言"
            className="rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <ArrowLeftRight className="h-4 w-4" />
          </button>
          <LanguagePicker
            value={targetLang}
            onChange={setTargetLang}
            ariaLabel="目标语言"
          />
          <TranslationModePicker
            value={translationMode}
            onChange={handleTranslationModeChange}
          />
        </div>

        {/* Hero mic button */}
        <div className="mt-16 flex flex-col items-center gap-5 sm:mt-24 sm:gap-6">
          <button
            type="button"
            onClick={startRecording}
            disabled={starting}
            aria-label="开始录制"
            className="bg-mic-gradient ring-mic-halo relative flex h-24 w-24 items-center justify-center rounded-full text-white transition-transform hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed disabled:opacity-70 sm:h-28 sm:w-28 lg:h-32 lg:w-32"
          >
            {starting ? (
              <Loader2 className="h-9 w-9 animate-spin sm:h-10 sm:w-10" />
            ) : (
              <Mic className="h-9 w-9 sm:h-10 sm:w-10" strokeWidth={1.5} />
            )}
          </button>
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">点击开始转录</p>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
              onClick={() => toast("上传音频：即将推出")}
            >
              <Upload className="h-3 w-3" />
              <span>或上传音频文件</span>
            </button>
          </div>
        </div>

        <LocalTranslatorDialog
          open={localSetupOpen}
          onOpenChange={setLocalSetupOpen}
          sourceLanguage={sourceLang}
          targetLanguage={targetLang}
          onReady={() => setTranslationMode("local")}
          onCancel={() => setTranslationMode("cloud")}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] gap-4 px-3 pb-4 pt-4 min-h-[calc(100vh-3rem)] md:max-w-[1024px] md:px-4 lg:max-w-[1280px] lg:px-6 xl:max-w-[1440px] 2xl:max-w-[1600px] 2xl:px-8">
    <div className="flex w-full min-w-0 flex-1 flex-col gap-3 md:gap-4">
      {/* Top action bar — flat items inline, no boxed background, matching
          lecsync's recording header where state pill + buttons just live
          on the page background. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 sm:gap-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <ConnectionPill status={state.status} />
          <LevelMeter level={state.level} />
          <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300 sm:text-sm">
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
          {/* Secondary controls — hidden on mobile, collapsed into the
              "more" menu below. Desktop (sm+) shows them inline. */}
          <button
            type="button"
            onClick={swapLanguages}
            aria-label="对调显示方向"
            className="hidden items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900 sm:inline-flex"
          >
            <span className="font-mono">{sourceLang.toUpperCase()}</span>
            <ArrowLeftRight className="h-3 w-3" />
            <span className="font-mono">{targetLang.toUpperCase()}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="hidden sm:inline-flex">
                <ArrowDownUp className="h-4 w-4" />
                <span>{DISPLAY_MODE_LABEL[displayMode]}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={displayMode}
                onValueChange={(v) => setDisplayMode(v as DisplayMode)}
              >
                <DropdownMenuRadioItem value="balanced">平衡</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="source-emphasis">原文优先</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="translation-emphasis">译文优先</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLiveShareOpen(true)}
            disabled={!sessionId}
            className="hidden sm:inline-flex"
          >
            <Share2 className="h-4 w-4" />
            <span>实时分享</span>
          </Button>

          {/* Mobile-only "more" menu — collapses the three secondary
              controls into one dropdown so the action bar fits on a
              375px phone without wrapping into three rows. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="更多操作"
                className="h-9 w-9 p-0 sm:hidden"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={swapLanguages}>
                <ArrowLeftRight className="mr-2 h-4 w-4" />
                对调方向（{sourceLang.toUpperCase()} ↔ {targetLang.toUpperCase()}）
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>显示模式</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={displayMode}
                onValueChange={(v) => setDisplayMode(v as DisplayMode)}
              >
                <DropdownMenuRadioItem value="balanced">平衡</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="source-emphasis">原文优先</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="translation-emphasis">译文优先</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setLiveShareOpen(true)}
                disabled={!sessionId}
              >
                <Share2 className="mr-2 h-4 w-4" />
                实时分享
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="destructive"
            size="sm"
            onClick={() => setStopConfirmOpen(true)}
          >
            <Square className="h-4 w-4" />
            <span className="hidden sm:inline">结束录制</span>
          </Button>
        </div>
      </div>

      {sessionId ? (
        <LiveShareDialog
          sessionId={sessionId}
          open={liveShareOpen}
          onOpenChange={setLiveShareOpen}
          onTokenMinted={({ token }) => {
            recorderRef.current?.setLiveShareToken(token);
          }}
        />
      ) : null}

      {/* Transcript history — only rendered when there's something finalized.
          The in-flight LIVE card is intentionally NOT inside this card; it
          lives in the bottom cluster below so it sits with the transport
          pill, matching lecsync's "music player" recording page. */}
      {hasHistory ? (
        <UtteranceList
          finalIds={finalIds}
          byId={state.byId}
          showTranslation={showTranslation}
          displayMode={displayMode}
          multiSpeaker={multiSpeaker}
        />
      ) : null}

      {/* Bottom cluster: LIVE card + transport pill, pushed to the bottom
          via mt-auto so empty middle space stays between the transcript and
          this group. */}
      <div className="mt-auto flex flex-col gap-3 pt-4">
        {showLiveCard ? (
          <LiveCard
            utterance={liveUtterance}
            recording={recording}
            showTranslation={showTranslation}
            displayMode={displayMode}
          />
        ) : null}
        <div className="flex justify-center">
          <div className="flex items-center gap-1 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
            <span className="px-2 font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              {state.status === "paused" ? "已暂停" : "录制中"} ·{" "}
              {formatElapsed(elapsedMs)}
            </span>
            <span className="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-800" />
            {sessionId && (
              <BookmarkInRecording
                sessionId={sessionId}
                getCurrentMs={getCurrentMs}
                disabled={!recording}
              />
            )}
            <FloatingSubtitleToggle
              items={floatingItems}
              recording={recording}
              showTranslation={showTranslation}
            />
            <Button
              variant="ghost"
              size="icon"
              // Touch-friendly on mobile (44×44 is the iOS HIG minimum,
              // 11×4=44px), compact on desktop.
              className="h-11 w-11 rounded-full sm:h-8 sm:w-8"
              onClick={async () => {
                const rec = recorderRef.current;
                if (!rec) return;
                if (state.status === "paused") {
                  await rec.resume();
                } else if (state.status === "recording") {
                  await rec.pause();
                }
              }}
              disabled={
                state.status !== "recording" && state.status !== "paused"
              }
              title={state.status === "paused" ? "继续" : "暂停"}
              aria-label={state.status === "paused" ? "继续" : "暂停"}
            >
              {state.status === "paused" ? (
                <Play className="h-4 w-4" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={stopConfirmOpen} onOpenChange={setStopConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>结束录制？</DialogTitle>
            <DialogDescription>
              结束后将立即停止转写、上传剩余音频并跳转到详情页。当前进行中的句子会被记入。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setStopConfirmOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setStopConfirmOpen(false);
                void stopRecording();
              }}
            >
              <Square className="h-4 w-4" />
              <span>结束录制</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    {/* Right sidebar (lecsync-style 纪要 / 对话 / 文件). Hidden on <lg. */}
    <RecorderSidebar
      sessionId={sessionId}
      folderId={null}
      minutesSections={minutesSections}
      pendingSection={pendingSection}
      minutesStatus={minutesStatus}
      onRefreshMinutes={() => refreshLiveMinutes()}
    />
    </div>
  );
}

// ------------------------------------------------------------------
// Subcomponents
// ------------------------------------------------------------------

function ConnectionPill({ status }: { status: RecorderState }) {
  // Map recorder state -> label + tone. All variants are visible without
  // truncation so the user always knows what's going on.
  let label: string;
  let tone: "live" | "warn" | "off" | "ok";
  let pulse = false;
  switch (status) {
    case "recording":
      label = "Live";
      tone = "live";
      pulse = true;
      break;
    case "paused":
      label = "已暂停";
      tone = "warn";
      break;
    case "permission":
      label = "请求权限…";
      tone = "warn";
      break;
    case "connecting":
      label = "连接中…";
      tone = "warn";
      pulse = true;
      break;
    case "connected":
      label = "已连接";
      tone = "ok";
      break;
    case "reconnecting":
      label = "重连中…";
      tone = "warn";
      pulse = true;
      break;
    case "stopping":
      label = "结束中…";
      tone = "off";
      break;
    case "ended":
      label = "已结束";
      tone = "off";
      break;
    case "error":
      label = "出错";
      tone = "warn";
      break;
    default:
      label = "已断开";
      tone = "off";
  }

  const toneClass = {
    live: "border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300",
    warn: "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    ok: "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    off: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
  }[tone];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        toneClass
      )}
    >
      <Radio className={cn("h-3 w-3", pulse && "animate-pulse")} />
      {label}
    </span>
  );
}

function LevelMeter({ level }: { level: number }) {
  const bars = 12;
  const clamped = Math.max(0, Math.min(1, level));
  const active = Math.round(clamped * bars);
  return (
    <div className="flex items-end gap-0.5" aria-label="audio level">
      {Array.from({ length: bars }, (_, i) => {
        const heightPct = 30 + (i / (bars - 1)) * 70;
        const on = i < active;
        return (
          <span
            key={i}
            style={{ height: `${heightPct}%` }}
            className={cn(
              "w-1 rounded-sm",
              on ? "bg-emerald-500" : "bg-zinc-200 dark:bg-zinc-800"
            )}
          />
        );
      })}
    </div>
  );
}

interface UtteranceListProps {
  finalIds: string[];
  byId: Record<string, Utterance>;
  showTranslation: boolean;
  displayMode: DisplayMode;
  multiSpeaker: boolean;
}

function UtteranceList({
  finalIds,
  byId,
  showTranslation,
  displayMode,
  multiSpeaker,
}: UtteranceListProps) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  // `pinnedRef` mirrors `showJumpToBottom` but lives outside React state so
  // the scroll-handler can read the latest value without triggering re-renders.
  // We *do* setState so the "jump to bottom" button can mount/unmount, but we
  // gate it on a rAF-throttled scroll handler to keep cost flat as new
  // utterances stream in.
  const pinnedRef = React.useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = React.useState(false);

  // Track whether the user has scrolled away from the bottom. The previous
  // implementation auto-scrolled on every new finalized utterance with no
  // user-scroll detection, which made reading history impossible during a
  // live recording (each new line yanked the view back down).
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf: number | null = null;
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        const nextPinned = dist < 64; // 64px tolerance for "at bottom"
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

  // Only auto-scroll when the user is already at the bottom. Reading history
  // mid-recording now sticks.
  React.useEffect(() => {
    if (pinnedRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [finalIds.length, byId]);

  const handleJumpToBottom = React.useCallback(() => {
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  return (
    <div className="relative flex flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="relative flex-1">
        <div
          ref={scrollerRef}
          className="h-full max-h-[58vh] overflow-y-auto overflow-x-hidden overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_64px)]"
        >
          <div className="space-y-5 p-6 pt-10">
            {finalIds.map((id) => {
              const u = byId[id];
              if (!u) return null;
              return (
                <Segment
                  key={u.id}
                  utterance={u}
                  showTranslation={showTranslation}
                  displayMode={displayMode}
                  showSpeaker={multiSpeaker}
                />
              );
            })}
            <div ref={bottomRef} aria-hidden />
          </div>
        </div>
        {showJumpToBottom ? (
          <button
            type="button"
            onClick={handleJumpToBottom}
            className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm backdrop-blur transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
            aria-label="回到最新"
          >
            <ArrowDown className="h-3 w-3" aria-hidden />
            回到最新
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Segment({
  utterance,
  showTranslation,
  displayMode,
  showSpeaker,
}: {
  utterance: Utterance;
  showTranslation: boolean;
  displayMode: DisplayMode;
  showSpeaker: boolean;
}) {
  const hasTranslation = showTranslation && !!utterance.translatedText;
  const stamp = formatElapsed(utterance.startMs);

  // When translation hasn't arrived yet (or is intentionally off) the source
  // becomes the only text, so always render it as primary — otherwise the
  // card looks like a half-empty 灰字 line. Once translation lands, the
  // displayMode preference takes over the relative emphasis.
  const sourceClass = !hasTranslation
    ? "text-base md:text-lg font-medium text-zinc-900 dark:text-zinc-50"
    : displayMode === "source-emphasis"
    ? "text-base md:text-lg font-medium text-zinc-900 dark:text-zinc-50"
    : displayMode === "balanced"
    ? "text-sm md:text-base text-zinc-700 dark:text-zinc-200"
    : "text-sm text-zinc-500 dark:text-zinc-400";
  const translationClass =
    displayMode === "translation-emphasis"
      ? "text-base md:text-lg font-medium text-zinc-900 dark:text-zinc-50"
      : displayMode === "balanced"
      ? "text-sm md:text-base text-zinc-700 dark:text-zinc-200"
      : "text-sm text-zinc-500 dark:text-zinc-400";
  const textWrapClass = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

  return (
    <div className="group/segment relative space-y-1.5">
      {showSpeaker && utterance.speakerId != null ? (
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span
            className={cn("h-1.5 w-1.5 rounded-full", speakerColor(utterance.speakerId))}
            aria-hidden
          />
          <span className="font-medium">{speakerLabel(utterance.speakerId)}</span>
          <span className="text-zinc-300 dark:text-zinc-700">·</span>
          <span className="font-mono tabular-nums">{stamp}</span>
        </div>
      ) : (
        <div className="mb-0.5 font-mono text-[10px] tabular-nums text-zinc-400 dark:text-zinc-600">
          {stamp}
        </div>
      )}
      {utterance.sourceText ? (
        <p className={cn("leading-relaxed", textWrapClass, sourceClass)}>
          {utterance.sourceText}
        </p>
      ) : null}
      {hasTranslation ? (
        <p className={cn("leading-relaxed", textWrapClass, translationClass)}>
          {utterance.translatedText}
        </p>
      ) : null}
    </div>
  );
}

function LiveCard({
  utterance,
  recording,
  showTranslation,
  displayMode,
}: {
  utterance: Utterance | null;
  recording: boolean;
  showTranslation: boolean;
  displayMode: DisplayMode;
}) {
  const sourceRef = React.useRef<HTMLDivElement | null>(null);
  const transRef = React.useRef<HTMLDivElement | null>(null);

  // Pin each pane to its bottom as new text streams in.
  React.useEffect(() => {
    if (sourceRef.current) sourceRef.current.scrollTop = sourceRef.current.scrollHeight;
  }, [utterance?.sourceText]);
  React.useEffect(() => {
    if (transRef.current) transRef.current.scrollTop = transRef.current.scrollHeight;
  }, [utterance?.translatedText]);

  const sourceText = utterance?.sourceText ?? "";
  const translatedText = utterance?.translatedText ?? "";
  const hasTranslation = showTranslation && !!translatedText;
  const isListening = !sourceText && recording;

  // Decouple font-size from `hasTranslation` to kill the layout-shift /
  // jitter that used to happen every frame Soniox (or Chrome Translator)
  // re-snapshotted `transPending`. The old code switched source from
  // text-2xl/3xl to text-lg/xl the instant the first pending translation
  // landed, mid-sentence — visually jarring.
  //
  // Now: the type scale is purely a function of `displayMode` plus whether
  // the user has translation enabled at all (`showTranslation`). When
  // translation is off we collapse to source-emphasis so the lone source
  // line still reads like a header. Neither of those inputs flips during a
  // single utterance, so font-size stays stable while content streams in.
  const effectiveMode: DisplayMode = showTranslation ? displayMode : "source-emphasis";
  const sourceClass =
    effectiveMode === "source-emphasis"
      ? "text-2xl md:text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50"
      : effectiveMode === "balanced"
      ? "text-xl md:text-2xl font-semibold text-zinc-800 dark:text-zinc-100"
      : "text-lg md:text-xl text-zinc-600 dark:text-zinc-300";
  const translationClass =
    effectiveMode === "translation-emphasis"
      ? "text-2xl md:text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50"
      : effectiveMode === "balanced"
      ? "text-xl md:text-2xl font-semibold text-zinc-800 dark:text-zinc-100"
      : "text-base md:text-lg text-zinc-600 dark:text-zinc-300";
  const textWrapClass = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

  return (
    <div
      className={cn(
        "relative w-full min-w-0 overflow-hidden rounded-xl border backdrop-blur-md",
        recording
          ? "border-rose-200/80 bg-gradient-to-br from-rose-50/80 via-white/85 to-rose-50/40 shadow-sm ring-1 ring-rose-200/40 dark:border-rose-900/40 dark:from-rose-950/30 dark:via-zinc-900/60 dark:to-rose-950/20 dark:ring-rose-900/30"
          : "border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      )}
    >
      <div className="relative z-10 min-w-0 space-y-2 p-4 md:p-5">
        {isListening ? (
          <p className="flex items-center gap-2 py-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Radio className="h-3.5 w-3.5 animate-pulse text-rose-500" />
            <span>正在监听…</span>
          </p>
        ) : (
          <>
            {sourceText ? (
              <div
                ref={sourceRef}
                className="max-h-28 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain pr-1"
              >
                <p
                  className={cn(
                    "leading-relaxed",
                    textWrapClass,
                    sourceClass
                  )}
                >
                  {sourceText}
                  {recording ? (
                    <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-rose-500 align-middle dark:bg-rose-400" />
                  ) : null}
                </p>
              </div>
            ) : null}
            {hasTranslation ? (
              <div
                ref={transRef}
                className="max-h-28 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain pr-1"
              >
                <p
                  className={cn(
                    "leading-snug",
                    textWrapClass,
                    translationClass
                  )}
                >
                  {translatedText}
                  {recording ? (
                    <span className="ml-1 animate-pulse text-zinc-400 dark:text-zinc-500">
                      …
                    </span>
                  ) : null}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
      <div
        className={cn(
          "relative z-10 flex items-center gap-2 border-t px-4 py-1.5",
          recording
            ? "border-rose-200/60 dark:border-rose-900/30"
            : "border-zinc-200 dark:border-zinc-800"
        )}
      >
        <span className="relative flex h-2 w-2">
          {recording ? (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/60 opacity-75" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              recording ? "bg-rose-500" : "bg-zinc-400"
            )}
          />
        </span>
        <span
          className={cn(
            "font-mono text-[11px] uppercase tracking-widest",
            recording ? "text-rose-600/80 dark:text-rose-400/80" : "text-zinc-500"
          )}
        >
          {recording ? "Live" : "Paused"}
        </span>
      </div>
    </div>
  );
}

export default Recorder;
