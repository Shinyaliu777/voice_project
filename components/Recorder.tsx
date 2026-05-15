"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mic, Radio, Share2, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { LanguagePicker } from "@/components/LanguagePicker";
import { AudioSourcePicker } from "@/components/AudioSourcePicker";
import { TranslationModePicker } from "@/components/TranslationModePicker";
import { isChromeTranslatorAvailable } from "@/lib/translation/chrome-local";
import { Recorder as AudioRecorder } from "@/lib/audio/recorder";
import type {
  AudioSource,
  RecorderEvent,
  RecorderState,
  SessionDTO,
  SonioxTokenResponse,
  TranslationMode,
} from "@/lib/contracts";

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

interface LiveToken {
  id: string;
  text: string;
  isFinal: boolean;
  isTranslation: boolean;
  speakerId?: number;
  startMs: number;
  endMs: number;
}

interface LiveState {
  status: RecorderState;
  level: number;
  startedAt: number | null;
  /** Map of token id -> token for the in-flight (non-final) source tokens */
  pendingSource: LiveToken[];
  pendingTranslation: LiveToken[];
  finalSource: LiveToken[];
  finalTranslation: LiveToken[];
}

type Action =
  | { type: "reset" }
  | { type: "started"; at: number }
  | { type: "state"; value: RecorderState }
  | { type: "level"; value: number }
  | { type: "token"; value: LiveToken };

function initialState(): LiveState {
  return {
    status: "idle",
    level: 0,
    startedAt: null,
    pendingSource: [],
    pendingTranslation: [],
    finalSource: [],
    finalTranslation: [],
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
    case "token": {
      const tok = action.value;
      const finalsKey = tok.isTranslation ? "finalTranslation" : "finalSource";
      const pendingKey = tok.isTranslation ? "pendingTranslation" : "pendingSource";

      if (tok.isFinal) {
        // Promote to finals (replace if same id existed in pending or finals)
        const finals = state[finalsKey].filter((t) => t.id !== tok.id).concat(tok);
        const pendings = state[pendingKey].filter((t) => t.id !== tok.id);
        return { ...state, [finalsKey]: finals, [pendingKey]: pendings } as LiveState;
      } else {
        // Update or insert in pending
        const others = state[pendingKey].filter((t) => t.id !== tok.id);
        return { ...state, [pendingKey]: others.concat(tok) } as LiveState;
      }
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

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export interface RecorderComponentProps {
  /** Default source language */
  defaultSourceLang?: string;
  /** Default target language */
  defaultTargetLang?: string;
  /** Default audio source */
  defaultAudioSource?: AudioSource;
  /** Default title for the session (else current locale string) */
  defaultTitle?: string;
  /** Optional callback when a session is created */
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
  const [translationMode, setTranslationMode] = React.useState<TranslationMode>("local");
  const [starting, setStarting] = React.useState(false);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  const [state, dispatch] = React.useReducer(reducer, undefined, initialState);
  const recorderRef = React.useRef<AudioRecorder | null>(null);
  const [nowTs, setNowTs] = React.useState(0);

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
        rec.stop().catch(() => {
          /* swallow */
        });
        recorderRef.current = null;
      }
    };
  }, []);

  const handleEvent = React.useCallback((event: RecorderEvent) => {
    if (event.state) dispatch({ type: "state", value: event.state });
    if (typeof event.level === "number") dispatch({ type: "level", value: event.level });
    if (event.token) {
      dispatch({
        type: "token",
        value: {
          id: event.token.id,
          text: event.token.text,
          isFinal: event.token.isFinal,
          isTranslation: Boolean(event.token.isTranslation),
          speakerId: event.token.speakerId,
          startMs: event.token.startMs,
          endMs: event.token.endMs,
        },
      });
    }
    if (event.error) {
      toast.error(event.error.message || "Recorder error");
    }
  }, []);

  const startRecording = React.useCallback(async () => {
    if (starting || state.status === "recording") return;
    setStarting(true);
    try {
      const title = defaultTitle ?? new Date().toLocaleString();
      // 1. Create the session
      const sessionResp = await fetch("/api/transcription/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sourceLang, targetLang }),
      });
      if (!sessionResp.ok) throw new Error(`Failed to create session (${sessionResp.status})`);
      const session = (await sessionResp.json()) as SessionDTO;
      setSessionId(session.id);
      onSessionCreated?.(session);

      // 2. Mint a Soniox token
      const tokenResp = await fetch("/api/soniox-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!tokenResp.ok) throw new Error(`Failed to mint token (${tokenResp.status})`);
      const token = (await tokenResp.json()) as SonioxTokenResponse;

      // 3. Create the recorder
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

      // 4. Start it
      recorderRef.current = rec;
      await rec.start();
      dispatch({ type: "started", at: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not start recording";
      toast.error(msg);
      const rec = recorderRef.current;
      if (rec) {
        await rec.stop().catch(() => {
          /* ignore */
        });
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

  const elapsedMs =
    state.startedAt != null && nowTs > 0 ? Math.max(0, nowTs - state.startedAt) : 0;

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  if (state.status === "idle") {
    return (
      <Card className="mx-auto w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic className="h-5 w-5" /> 新建录制
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <LanguagePicker
              value={sourceLang}
              onChange={setSourceLang}
              label="源语言"
              ariaLabel="源语言"
            />
            <LanguagePicker
              value={targetLang}
              onChange={setTargetLang}
              label="目标语言"
              ariaLabel="目标语言"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <AudioSourcePicker value={audioSource} onChange={setAudioSource} />
            <TranslationModePicker value={translationMode} onChange={setTranslationMode} />
          </div>
          <Separator />
          <div className="flex justify-center pt-2">
            <Button
              size="lg"
              onClick={startRecording}
              disabled={starting}
              className="h-14 rounded-full px-10 text-base"
            >
              {starting ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
              <span className="ml-2">开始录制</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Recording UI
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          <Badge variant="destructive" className="gap-1.5">
            <Radio className="h-3.5 w-3.5 animate-pulse" />
            Live
          </Badge>
          <LevelMeter level={state.level} />
          <span className="font-mono text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">→ {targetLang.toUpperCase()}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => toast("实时分享：即将推出")}
          >
            <Share2 className="h-4 w-4" />
            <span>实时分享</span>
          </Button>
          <Button variant="destructive" size="sm" onClick={stopRecording}>
            <Square className="h-4 w-4" />
            <span>结束录制</span>
          </Button>
        </div>
      </div>

      {/* Live transcript */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <LiveColumn
          title="原文"
          finals={state.finalSource}
          pending={state.pendingSource}
        />
        <LiveColumn
          title="译文"
          finals={state.finalTranslation}
          pending={state.pendingTranslation}
          muted
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Subcomponents
// ------------------------------------------------------------------

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

interface LiveColumnProps {
  title: string;
  finals: LiveToken[];
  pending: LiveToken[];
  muted?: boolean;
}

function LiveColumn({ title, finals, pending, muted }: LiveColumnProps) {
  // Group finals by speakerId (consecutive groups)
  const finalsBySpeaker = React.useMemo(() => groupConsecutive(finals), [finals]);
  const pendingBySpeaker = React.useMemo(() => groupConsecutive(pending), [pending]);
  return (
    <Card className="min-h-[50vh]">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-zinc-500 dark:text-zinc-400">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {finalsBySpeaker.map((group, idx) => (
          <SpeakerLine key={`final-${idx}`} group={group} muted={muted} />
        ))}
        {pendingBySpeaker.map((group, idx) => (
          <SpeakerLine
            key={`pending-${idx}`}
            group={group}
            muted={muted}
            pending
          />
        ))}
        {finals.length === 0 && pending.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-400">
            正在监听…
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface TokenGroup {
  speakerId?: number;
  tokens: LiveToken[];
}

function groupConsecutive(tokens: LiveToken[]): TokenGroup[] {
  const sorted = [...tokens].sort((a, b) => a.startMs - b.startMs);
  const out: TokenGroup[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && last.speakerId === t.speakerId) {
      last.tokens.push(t);
    } else {
      out.push({ speakerId: t.speakerId, tokens: [t] });
    }
  }
  return out;
}

function SpeakerLine({
  group,
  muted,
  pending,
}: {
  group: TokenGroup;
  muted?: boolean;
  pending?: boolean;
}) {
  const text = group.tokens.map((t) => t.text).join(" ");
  return (
    <div className="flex items-start gap-2">
      <span
        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", speakerColor(group.speakerId))}
        aria-hidden
      />
      <p
        className={cn(
          "flex-1 text-sm leading-relaxed",
          muted ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-900 dark:text-zinc-100",
          pending && "opacity-60"
        )}
      >
        {text}
      </p>
    </div>
  );
}

export default Recorder;
