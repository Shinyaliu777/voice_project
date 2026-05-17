"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDownUp,
  ArrowLeftRight,
  Loader2,
  Mic,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { BookmarkInRecording } from "@/components/BookmarkInRecording";
import { FloatingSubtitleToggle } from "@/components/FloatingSubtitleToggle";
import { LiveShareDialog } from "@/components/LiveShareDialog";
import { MinutesView } from "@/components/MinutesView";
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
  const [translationMode, setTranslationMode] = React.useState<TranslationMode>("local");
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

  const [minutesSections, setMinutesSections] = React.useState<MinutesSection[]>([]);
  const [minutesStatus, setMinutesStatus] = React.useState<"idle" | "streaming" | "error">("idle");
  const minutesAbortRef = React.useRef<AbortController | null>(null);

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
    setMinutesSections([]);
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

  const refreshLiveMinutes = React.useCallback(async () => {
    if (!sessionId || minutesStatus === "streaming") return;
    minutesAbortRef.current?.abort();
    const ctrl = new AbortController();
    minutesAbortRef.current = ctrl;
    setMinutesStatus("streaming");

    try {
      const resp = await fetch(`/api/sessions/${sessionId}/minutes/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: targetLang }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`Failed to stream minutes (${resp.status})`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const collected: MinutesSection[] = [];
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
          if (payload.type === "section_confirmed" || payload.type === "section_pending") {
            collected.push(payload.section);
            setMinutesSections([...collected]);
          } else if (payload.type === "error") {
            throw new Error(payload.message);
          }
        }
      }
      setMinutesStatus("idle");
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setMinutesStatus("error");
      toast.error(err instanceof Error ? err.message : "纪要生成失败");
    }
  }, [sessionId, targetLang, minutesStatus]);

  const elapsedMs =
    state.startedAt != null && nowTs > 0 ? Math.max(0, nowTs - state.startedAt) : 0;
  const elapsedRef = React.useRef(elapsedMs);
  elapsedRef.current = elapsedMs;
  const getCurrentMs = React.useCallback(() => elapsedRef.current, []);

  // Latest utterance for the floating subtitle window.
  const latestUtterance = React.useMemo<Utterance | null>(() => {
    if (state.order.length === 0) return null;
    return state.byId[state.order[state.order.length - 1]] ?? null;
  }, [state.order, state.byId]);

  const showTranslation = translationMode !== "off";
  const recording = state.status === "recording";

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
          <TranslationModePicker value={translationMode} onChange={setTranslationMode} />
        </div>

        {/* Hero mic button */}
        <div className="mt-24 flex flex-col items-center gap-6">
          <button
            type="button"
            onClick={startRecording}
            disabled={starting}
            aria-label="开始录制"
            className="bg-mic-gradient ring-mic-halo relative flex h-28 w-28 items-center justify-center rounded-full text-white transition-transform hover:scale-[1.03] active:scale-95 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {starting ? (
              <Loader2 className="h-10 w-10 animate-spin" />
            ) : (
              <Mic className="h-10 w-10" strokeWidth={1.5} />
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
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          <ConnectionPill status={state.status} />
          <LevelMeter level={state.level} />
          <span className="font-mono text-sm tabular-nums text-zinc-600 dark:text-zinc-300">
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={swapLanguages}
            aria-label="对调显示方向"
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            <span className="font-mono">{sourceLang.toUpperCase()}</span>
            <ArrowLeftRight className="h-3 w-3" />
            <span className="font-mono">{targetLang.toUpperCase()}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
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
          {sessionId && (
            <BookmarkInRecording
              sessionId={sessionId}
              getCurrentMs={getCurrentMs}
              disabled={!recording}
            />
          )}
          <FloatingSubtitleToggle
            latestSourceText={latestUtterance?.sourceText ?? ""}
            latestTranslatedText={latestUtterance?.translatedText ?? ""}
            recording={recording}
            showTranslation={showTranslation}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLiveShareOpen(true)}
            disabled={!sessionId}
          >
            <Share2 className="h-4 w-4" />
            <span>实时分享</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const rec = recorderRef.current;
              if (!rec) return;
              if (state.status === "paused") {
                await rec.resume();
              } else if (state.status === "recording") {
                await rec.pause();
              }
            }}
            disabled={state.status !== "recording" && state.status !== "paused"}
          >
            {state.status === "paused" ? (
              <>
                <Play className="h-4 w-4" />
                <span>继续</span>
              </>
            ) : (
              <>
                <Pause className="h-4 w-4" />
                <span>暂停</span>
              </>
            )}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setStopConfirmOpen(true)}
          >
            <Square className="h-4 w-4" />
            <span>结束录制</span>
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

      {/* Utterance stream */}
      <UtteranceList
        order={state.order}
        byId={state.byId}
        showTranslation={showTranslation}
        displayMode={displayMode}
        recording={recording}
      />

      {/* Live minutes panel */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            实时纪要
            {minutesStatus === "streaming" && (
              <span className="ml-2 text-xs text-zinc-500">生成中…</span>
            )}
            {minutesStatus === "error" && (
              <span className="ml-2 text-xs text-rose-500">出错，点刷新重试</span>
            )}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshLiveMinutes}
            disabled={!sessionId || minutesStatus === "streaming"}
          >
            {minutesStatus === "streaming" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span>刷新纪要</span>
          </Button>
        </CardHeader>
        <CardContent>
          {minutesSections.length === 0 ? (
            <p className="py-2 text-sm text-zinc-500">
              录一段后点"刷新纪要"基于当前转录生成要点（消耗 LLM 配额）。
            </p>
          ) : (
            <MinutesView sections={minutesSections} />
          )}
        </CardContent>
      </Card>

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
  order: string[];
  byId: Record<string, Utterance>;
  showTranslation: boolean;
  displayMode: DisplayMode;
  recording: boolean;
}

function UtteranceList({
  order,
  byId,
  showTranslation,
  displayMode,
  recording,
}: UtteranceListProps) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);

  // The last in-flight (non-final) utterance powers the bottom live card.
  // Everything else flows into the history stream above it.
  let liveId: string | null = null;
  for (let i = order.length - 1; i >= 0; i--) {
    const u = byId[order[i]];
    if (u && !u.isFinal) {
      liveId = u.id;
      break;
    }
  }
  const finalIds = liveId ? order.filter((id) => id !== liveId) : order;
  const liveUtterance = liveId ? byId[liveId] ?? null : null;

  // Whether the segment headers need to show speaker names. Lecsync only does
  // this when there's actually more than one speaker in the conversation.
  const multiSpeaker = React.useMemo(() => {
    const ids = new Set<number>();
    for (const id of finalIds) {
      const u = byId[id];
      if (u?.speakerId != null) ids.add(u.speakerId);
    }
    if (liveUtterance?.speakerId != null) ids.add(liveUtterance.speakerId);
    return ids.size > 1;
  }, [finalIds, byId, liveUtterance]);

  // Pin to bottom when content grows, matching lecsync's live cadence.
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [order.length, liveId, byId]);

  const hasHistory = finalIds.length > 0;
  const showLiveCard = liveUtterance !== null || recording;

  return (
    <div className="relative flex flex-col overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800/80 dark:bg-zinc-950">
      <div className="relative min-h-[280px] flex-1">
        <div
          ref={scrollerRef}
          className="h-full max-h-[58vh] overflow-y-auto overflow-x-hidden overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_64px)]"
        >
          <div className="space-y-5 p-6 pt-10">
            {hasHistory ? (
              <>
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
              </>
            ) : !showLiveCard ? (
              <p className="py-12 text-center text-base text-zinc-400 dark:text-zinc-500">
                正在监听…
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {showLiveCard ? (
        <div className="border-t border-zinc-100 px-4 pb-3 pt-3 dark:border-zinc-900">
          <LiveCard
            utterance={liveUtterance}
            recording={recording}
            showTranslation={showTranslation}
            displayMode={displayMode}
          />
        </div>
      ) : null}
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

  const sourceClass =
    displayMode === "source-emphasis"
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
        <p className={cn("leading-relaxed", sourceClass)}>{utterance.sourceText}</p>
      ) : null}
      {hasTranslation ? (
        <p className={cn("leading-relaxed", translationClass)}>
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

  const sourceClass =
    displayMode === "source-emphasis"
      ? "text-lg md:text-xl font-semibold text-zinc-900 dark:text-zinc-50"
      : displayMode === "balanced"
      ? "text-base md:text-lg text-zinc-800 dark:text-zinc-100"
      : "text-sm md:text-base text-zinc-500 dark:text-zinc-400";
  const translationClass =
    displayMode === "translation-emphasis"
      ? "text-2xl md:text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50"
      : displayMode === "balanced"
      ? "text-lg md:text-xl font-semibold text-zinc-800 dark:text-zinc-100"
      : "text-base text-zinc-600 dark:text-zinc-300";

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border backdrop-blur-md",
        recording
          ? "border-rose-200/80 bg-gradient-to-br from-rose-50/80 via-white/85 to-rose-50/40 shadow-sm ring-1 ring-rose-200/40 dark:border-rose-900/40 dark:from-rose-950/30 dark:via-zinc-900/60 dark:to-rose-950/20 dark:ring-rose-900/30"
          : "border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      )}
    >
      <div className="relative z-10 space-y-2 p-4 md:p-5">
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
                className="max-h-28 overflow-y-auto overscroll-contain pr-1"
              >
                <p className={cn("leading-relaxed", sourceClass)}>
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
                className="max-h-28 overflow-y-auto overscroll-contain pr-1"
              >
                <p className={cn("leading-snug", translationClass)}>
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
