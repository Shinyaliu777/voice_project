/**
 * TranscriptionService — slim recording core.
 *
 * Coordinates three pipelines:
 *   1. mic / system / file capture (getUserMedia / getDisplayMedia / file)
 *   2. AudioWorklet "pcm-encoder" → Soniox WebSocket (real-time transcription)
 *   3. MediaRecorder → emits chunk Blobs (the persistence plugin uploads them)
 *
 * Compared to `lib/audio/recorder.ts` this class is stripped of all
 * cross-cutting concerns — those live in plugins now:
 *
 *   - IndexedDB caching + sendBeacon              → persistence.ts
 *   - /api/minutes/stream live minutes refresh    → minutes.ts
 *   - share-token push to /api/live-share/...     → live-share.ts
 *   - long-silence detection                      → idle-detection.ts
 *   - recording queue / start-gate                → recording-control.ts
 *   - Picture-in-Picture floating subtitle        → pip.ts
 *
 * The service reports its events through `transcriptionEventBus.emit*()` —
 * no `onEvent` callback. Plugins subscribe to the bus to react. UI code
 * uses the Zustand store fed by `useTranscriptionEventSync`.
 *
 * NOTE: this file was bootstrapped by copying the relevant slice of
 * `lib/audio/recorder.ts` and stripping the plugin-owned concerns. The
 * original `Recorder` class is intentionally kept untouched during the
 * migration so the live UI keeps working off it.
 */

import type {
  CreateSegmentBody,
  RecorderConfig,
  RecorderState,
  SegmentDTO,
  Utterance,
} from "../contracts";
import type {
  SonioxFrame,
  UtteranceBuilder,
  WorkletInboundMessage,
} from "./types";
import { transcriptionEventBus } from "./event-bus";

// -------- Chrome Translator API shape (lib/translation/chrome-local.ts owns the global) --------

interface ChromeTranslator {
  availability(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<string>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<{ translate(text: string): Promise<string> }>;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_UPLOAD_INTERVAL_MS = 3000;
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const WORKLET_URL = "/worklets/pcm-encoder.js";

/**
 * Lightweight chunk descriptor pushed to subscribers via `onChunk`. The
 * persistence plugin consumes this — TranscriptionService itself no
 * longer talks to IndexedDB or the upload pipeline.
 */
export interface ChunkEvent {
  sessionId: string;
  chunkIndex: number;
  blob: Blob;
  durationSeconds: number;
  contentType: string;
}

/**
 * Hook the service exposes to plugins for advisory access — utterances
 * (so live-share can mirror them), segments (so live-share can push them
 * post-POST), and raw chunk emissions (so the persistence plugin can
 * own IndexedDB + sendBeacon + the upload state machine).
 */
export interface TranscriptionServiceListeners {
  onUtterance?(u: Utterance, isFinal: boolean): void;
  onSegment?(seg: SegmentDTO, utteranceId: string | undefined): void;
  onChunk?(chunk: ChunkEvent): void;
  /**
   * Best-effort handle for the `pagehide` last-chunk beacon — plugins
   * may attach their own listener that reads from the live in-flight
   * chunk. Currently nothing relies on this; the persistence plugin
   * keeps its own ref via `onChunk`.
   */
  onPageHide?(): void;
}

export class TranscriptionService {
  // ---- config ----
  // `config` is mutable so live-share token can be attached mid-session
  // (the user typically clicks "share" while already recording).
  private config: RecorderConfig;
  private listeners: TranscriptionServiceListeners = {};

  // ---- state ----
  private state: RecorderState = "idle";
  private startedAtMs: number | null = null;
  private totalPausedMs = 0;
  private pausedSince: number | null = null;

  // ---- media graph ----
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyserNode: AnalyserNode | null = null;

  // ---- WS ----
  private ws: WebSocket | null = null;
  private wsOpen = false;
  private pcmQueue: ArrayBuffer[] = [];
  private lastAudioSendAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ---- utterance / segment bookkeeping ----
  private utteranceCounter = 0;
  private segmentIndex = 0;
  private currentUtterances: Map<number | undefined, UtteranceBuilder> = new Map();
  private finalizeQueue: UtteranceBuilder[] = [];
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private segmentToUtterance: Map<string, string> = new Map();
  private liveTranslate: Map<
    number | undefined,
    {
      lastTranslated: string;
      timer: ReturnType<typeof setTimeout> | null;
      inFlight: boolean;
    }
  > = new Map();

  // ---- chunk pipeline (emit-only — uploads/IDB owned by persistence plugin) ----
  private mediaRecorder: MediaRecorder | null = null;
  private mediaMime = "audio/webm";
  private chunkIndex = 0;
  private lastChunkAtMs: number | null = null;

  // ---- device disconnect / recovery ----
  private trackEndedListener: (() => void) | null = null;
  private monitoredTrack: MediaStreamTrack | null = null;
  private deviceRecoveryAttempts = 0;
  private deviceRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEVICE_RECOVERY_MAX_ATTEMPTS = 3;
  private readonly DEVICE_RECOVERY_BACKOFF_MS = 2000;

  // ---- WS reconnect ----
  private intentionalShutdown = false;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WS_RECONNECT_BACKOFFS_MS = [500, 1500, 3000];

  // ---- cloud translation lag bridge ----
  private awaitingTrans: Map<
    number | undefined,
    Array<{ u: UtteranceBuilder; awaitingSince: number }>
  > = new Map();
  private readonly AWAIT_TRANS_GRACE_MS = 3000;

  // ---- file-mode audio source ----
  private fileAudioEl: HTMLAudioElement | null = null;
  private fileAudioObjectUrl: string | null = null;

  // ---- page visibility ----
  private boundVisibilityHandler: (() => void) | null = null;
  private boundAudioCtxStateChange: (() => void) | null = null;
  private boundPageHideHandler: (() => void) | null = null;

  // ---- Chrome Translator cache ----
  private chromeTranslators: Map<
    string,
    Promise<{ translate(text: string): Promise<string> } | null>
  > = new Map();
  private translateFallbackWarned = false;

  constructor(config: RecorderConfig, listeners?: TranscriptionServiceListeners) {
    this.config = config;
    if (listeners) this.listeners = listeners;
  }

  // ==========================================================================
  //   public API
  // ==========================================================================

  setListeners(listeners: TranscriptionServiceListeners): void {
    this.listeners = { ...this.listeners, ...listeners };
  }

  getConfig(): RecorderConfig {
    return this.config;
  }

  getState(): RecorderState {
    return this.state;
  }

  getMediaStream(): MediaStream | null {
    return this.stream;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`TranscriptionService.start() called from state=${this.state}`);
    }
    try {
      this.setState("permission");
      await this.acquireStream();

      this.setState("connecting");
      await this.buildAudioGraph();
      await this.openSonioxWs();
      this.startMediaRecorder();

      // Prewarm Chrome Translator (if user picked "local"). Costs nothing if
      // they didn't — fire-and-forget. Saves 200-500ms on the first segment.
      if (
        this.config.translationMode === "local" &&
        this.config.sourceLanguage !== this.config.targetLanguage
      ) {
        void this.getOrCreateChromeTranslator(
          this.config.sourceLanguage,
          this.config.targetLanguage
        );
        void this.getOrCreateChromeTranslator(
          this.config.targetLanguage,
          this.config.sourceLanguage
        );
      }

      this.attachVisibilityMonitor();
      this.attachPageHideMonitor();

      if (this.config.audioSource === "file" && this.fileAudioEl) {
        try {
          await this.fileAudioEl.play();
        } catch (err) {
          throw new Error(
            err instanceof Error
              ? `音频文件播放失败：${err.message}`
              : "音频文件播放失败"
          );
        }
      }

      this.startedAtMs = performance.now();
      this.setState("connected");
      this.setState("recording");
    } catch (err) {
      this.emitError(err, "start_failed", false);
      await this.shutdownInternal();
      this.setState("error");
      throw err;
    }
  }

  async pause(): Promise<void> {
    if (this.state !== "recording") return;
    try {
      this.mediaRecorder?.pause();
      this.pausedSince = performance.now();
      this.setState("paused");
    } catch (err) {
      this.emitError(err, "pause_failed", true);
    }
  }

  async resume(): Promise<void> {
    if (this.state !== "paused") return;
    try {
      this.mediaRecorder?.resume();
      if (this.pausedSince !== null) {
        this.totalPausedMs += performance.now() - this.pausedSince;
        this.pausedSince = null;
      }
      this.setState("recording");
    } catch (err) {
      this.emitError(err, "resume_failed", true);
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "ended") return;
    this.intentionalShutdown = true;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.setState("stopping");

    const recorderStopped = this.stopMediaRecorderAndDrain();

    for (const queue of this.awaitingTrans.values()) {
      for (const item of queue) {
        this.emitUtterance(item.u, true);
        this.finalizeQueue.push(item.u);
      }
    }
    this.awaitingTrans.clear();
    this.flushFinalizeQueueImmediate();
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(new ArrayBuffer(0));
      }
    } catch {
      /* ignore */
    }

    await recorderStopped.catch(() => undefined);

    // Persistence plugin owns the post-stop /api/audio/finalize call now.
    // Service only tears down media + WS here.
    const totalDurationMs = this.computeDurationMs();
    try {
      const resp = await fetch("/api/audio/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.config.sessionId,
          totalDurationMs,
        }),
      });
      if (!resp.ok) {
        this.emitError(
          new Error(`finalize -> ${resp.status}`),
          "finalize_failed",
          true
        );
      }
    } catch (err) {
      this.emitError(err, "finalize_failed", true);
    }

    await this.shutdownInternal();
    this.setState("ended");
  }

  /** Attach (or clear) a live-share token mid-recording. */
  setLiveShareToken(token: string | null | undefined): void {
    this.config = {
      ...this.config,
      liveShareToken: token ?? undefined,
    };
  }

  destroy(): void {
    this.intentionalShutdown = true;
    this.stopHeartbeat();
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.detachDeviceMonitor();
    this.detachVisibilityMonitor();
    this.detachPageHideMonitor();
    try {
      this.mediaRecorder?.stop();
    } catch { /* ignore */ }
    try {
      this.ws?.close();
    } catch { /* ignore */ }
    try {
      this.workletNode?.disconnect();
    } catch { /* ignore */ }
    try {
      this.sourceNode?.disconnect();
    } catch { /* ignore */ }
    try {
      this.analyserNode?.disconnect();
    } catch { /* ignore */ }
    try {
      this.audioCtx?.close();
    } catch { /* ignore */ }
    this.stream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    if (this.fileAudioObjectUrl) {
      try { URL.revokeObjectURL(this.fileAudioObjectUrl); } catch { /* ignore */ }
      this.fileAudioObjectUrl = null;
    }
  }

  // ==========================================================================
  //   media capture
  // ==========================================================================

  private async acquireStream(): Promise<void> {
    if (this.config.audioSource === "file") {
      if (!this.config.audioFile) {
        throw new Error("audioSource=file but no audioFile in RecorderConfig");
      }
      const url = URL.createObjectURL(this.config.audioFile);
      const audioEl = document.createElement("audio");
      audioEl.src = url;
      audioEl.crossOrigin = "anonymous";
      audioEl.preload = "auto";
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          audioEl.removeEventListener("loadedmetadata", onReady);
          audioEl.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          audioEl.removeEventListener("loadedmetadata", onReady);
          audioEl.removeEventListener("error", onError);
          reject(new Error("无法读取音频文件 — 格式可能不被支持"));
        };
        audioEl.addEventListener("loadedmetadata", onReady, { once: true });
        audioEl.addEventListener("error", onError, { once: true });
        audioEl.load();
      });
      const stream = (
        audioEl as HTMLMediaElement & { captureStream?: () => MediaStream }
      ).captureStream?.();
      if (!stream) {
        URL.revokeObjectURL(url);
        throw new Error(
          "当前浏览器不支持 audio.captureStream() — 请用 Chrome / Firefox"
        );
      }
      this.stream = stream;
      this.fileAudioEl = audioEl;
      this.fileAudioObjectUrl = url;
      audioEl.addEventListener(
        "ended",
        () => {
          if (this.state === "recording" || this.state === "paused") {
            void this.stop();
          }
        },
        { once: true }
      );
      return;
    }

    if (this.config.audioSource === "system") {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(
          "System audio capture returned no audio track; the user likely declined to share audio"
        );
      }
      stream.getVideoTracks().forEach((t) => {
        t.enabled = false;
      });
      this.stream = stream;
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
    }
    this.attachDeviceMonitor();
  }

  private attachDeviceMonitor(): void {
    this.detachDeviceMonitor();
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return;
    const listener = () => {
      this.monitoredTrack = null;
      this.trackEndedListener = null;
      if (this.state === "stopping" || this.state === "ended" || this.state === "idle") {
        return;
      }
      const label = track.label || "麦克风";
      void transcriptionEventBus.emitDeviceDisconnected({
        deviceLabel: label,
        reason: "track_ended",
      });
      this.emitError(new Error("麦克风已断开"), "device_disconnected", true);
      this.setState("reconnecting");
      this.deviceRecoveryAttempts = 0;
      void this.attemptDeviceRecovery();
    };
    track.addEventListener("ended", listener);
    this.monitoredTrack = track;
    this.trackEndedListener = listener;
  }

  private detachDeviceMonitor(): void {
    if (this.monitoredTrack && this.trackEndedListener) {
      try { this.monitoredTrack.removeEventListener("ended", this.trackEndedListener); } catch {}
    }
    this.monitoredTrack = null;
    this.trackEndedListener = null;
    if (this.deviceRecoveryTimer) {
      clearTimeout(this.deviceRecoveryTimer);
      this.deviceRecoveryTimer = null;
    }
  }

  private attachVisibilityMonitor(): void {
    if (typeof document === "undefined") return;
    this.detachVisibilityMonitor();

    this.boundVisibilityHandler = () => {
      if (document.hidden) return;
      void this.handleVisibilityReturn();
    };
    document.addEventListener("visibilitychange", this.boundVisibilityHandler);

    if (this.audioCtx) {
      this.boundAudioCtxStateChange = () => {
        const ctx = this.audioCtx;
        if (!ctx) return;
        void transcriptionEventBus.emitAudioContextStateChange({
          state: ctx.state,
        });
        if (
          ctx.state === "suspended" &&
          typeof document !== "undefined" &&
          !document.hidden &&
          this.state !== "paused" &&
          this.state !== "stopping" &&
          this.state !== "ended"
        ) {
          ctx.resume().catch(() => {});
        }
      };
      this.audioCtx.addEventListener("statechange", this.boundAudioCtxStateChange);
    }
  }

  private detachVisibilityMonitor(): void {
    if (typeof document !== "undefined" && this.boundVisibilityHandler) {
      try { document.removeEventListener("visibilitychange", this.boundVisibilityHandler); } catch {}
    }
    this.boundVisibilityHandler = null;
    if (this.audioCtx && this.boundAudioCtxStateChange) {
      try { this.audioCtx.removeEventListener("statechange", this.boundAudioCtxStateChange); } catch {}
    }
    this.boundAudioCtxStateChange = null;
  }

  /**
   * `pagehide` listener exists here only to forward to listeners — the
   * persistence plugin handles the actual sendBeacon. Without this hook
   * a plugin can't know "we're being unloaded".
   */
  private attachPageHideMonitor(): void {
    if (typeof window === "undefined") return;
    this.detachPageHideMonitor();
    this.boundPageHideHandler = () => {
      try { this.listeners.onPageHide?.(); } catch { /* swallow */ }
    };
    window.addEventListener("pagehide", this.boundPageHideHandler);
  }

  private detachPageHideMonitor(): void {
    if (typeof window !== "undefined" && this.boundPageHideHandler) {
      try { window.removeEventListener("pagehide", this.boundPageHideHandler); } catch {}
    }
    this.boundPageHideHandler = null;
  }

  private async handleVisibilityReturn(): Promise<void> {
    if (this.state === "stopping" || this.state === "ended" || this.state === "idle") {
      return;
    }
    try {
      if (this.audioCtx?.state === "suspended") {
        await this.audioCtx.resume();
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(new ArrayBuffer(0));
        } catch { /* ignore */ }
      }
      for (const u of this.currentUtterances.values()) {
        if (u.sourceFinal || u.sourcePending) {
          this.scheduleLiveTranslate(u);
        }
      }
    } catch (err) {
      console.warn("[transcription-service] visibility resume failed", err);
    }
  }

  private async attemptDeviceRecovery(): Promise<void> {
    if (this.state === "stopping" || this.state === "ended" || this.state === "idle") {
      return;
    }
    if (this.deviceRecoveryAttempts >= this.DEVICE_RECOVERY_MAX_ATTEMPTS) {
      this.emitError(
        new Error("麦克风恢复失败，请检查设备"),
        "device_recovery_failed",
        false
      );
      void transcriptionEventBus.emitDeviceRecoveryFailed({
        deviceLabel: this.monitoredTrack?.label ?? "麦克风",
        attempts: this.deviceRecoveryAttempts,
      });
      this.setState("error");
      return;
    }
    this.deviceRecoveryAttempts += 1;

    try {
      const oldStream = this.stream;
      this.stream = null;
      await this.acquireStream();
      if (!this.stream) throw new Error("re-acquire returned no stream");

      if (this.audioCtx && this.workletNode) {
        try { this.sourceNode?.disconnect(); } catch {}
        const newSource = this.audioCtx.createMediaStreamSource(this.stream);
        this.sourceNode = newSource;
        newSource.connect(this.workletNode);
        if (this.analyserNode) newSource.connect(this.analyserNode);
      }

      if (oldStream) {
        oldStream.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
      }

      const attempts = this.deviceRecoveryAttempts;
      this.deviceRecoveryAttempts = 0;
      this.setState("recording");
      void transcriptionEventBus.emitDeviceRecovered({
        deviceLabel: this.monitoredTrack?.label ?? "麦克风",
        attempts,
      });
      this.emitError(new Error("麦克风已恢复"), "device_recovered", true);
    } catch {
      this.deviceRecoveryTimer = setTimeout(
        () => void this.attemptDeviceRecovery(),
        this.DEVICE_RECOVERY_BACKOFF_MS
      );
    }
  }

  private async buildAudioGraph(): Promise<void> {
    if (!this.stream) throw new Error("No media stream");
    const Ctx: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    this.audioCtx = ctx;

    await ctx.audioWorklet.addModule(WORKLET_URL);

    const source = ctx.createMediaStreamSource(this.stream);
    this.sourceNode = source;

    const worklet = new AudioWorkletNode(ctx, "pcm-encoder");
    this.workletNode = worklet;
    worklet.port.postMessage({
      type: "config",
      targetSampleRate: this.config.sampleRate ?? DEFAULT_SAMPLE_RATE,
    });
    worklet.port.onmessage = (e: MessageEvent<WorkletInboundMessage>) => {
      this.handleWorkletMessage(e.data);
    };

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    this.analyserNode = analyser;

    source.connect(worklet);
    source.connect(analyser);
  }

  // ==========================================================================
  //   Soniox WebSocket
  // ==========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const sampleRate = this.config.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const silentBytes = Math.floor((sampleRate * 200) / 1000) * 2;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.wsOpen) return;
      const idleMs = performance.now() - this.lastAudioSendAt;
      if (idleMs < 3500) return;
      try {
        this.ws.send(new ArrayBuffer(silentBytes));
        this.lastAudioSendAt = performance.now();
      } catch {
        /* close handler will reconnect */
      }
    }, 1500);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async openSonioxWs(): Promise<void> {
    const ws = new WebSocket(SONIOX_WS_URL);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    void transcriptionEventBus.emitConnectionStatus({ status: "connecting" });

    const sampleRate = this.config.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const wantTranslation =
      this.config.translationMode === "cloud" &&
      this.config.sourceLanguage !== this.config.targetLanguage;

    const initConfig: Record<string, unknown> = {
      api_key: this.config.sonioxToken,
      model: this.config.sonioxModel ?? "stt-rt-v4",
      audio_format: "pcm_s16le",
      sample_rate: sampleRate,
      num_channels: 1,
      enable_speaker_diarization:
        this.config.enableSpeakerDiarization ?? true,
      enable_endpoint_detection: true,
      language_hints: [this.config.sourceLanguage],
    };
    if (this.config.transcriptionContext) {
      initConfig.context = this.config.transcriptionContext;
    }
    if (wantTranslation) {
      initConfig.translation = {
        type: "two_way",
        language_a: this.config.sourceLanguage,
        language_b: this.config.targetLanguage,
      };
    }

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        try {
          ws.send(JSON.stringify(initConfig));
        } catch (err) {
          reject(err);
          return;
        }
        this.wsOpen = true;
        this.lastAudioSendAt = performance.now();
        for (const buf of this.pcmQueue) {
          try { ws.send(buf); } catch { /* ignore */ }
        }
        this.pcmQueue = [];
        this.startHeartbeat();
        void transcriptionEventBus.emitConnectionStatus({ status: "connected" });
        resolve();
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        void transcriptionEventBus.emitConnectionStatus({ status: "error" });
        reject(new Error("Soniox WebSocket failed to open"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });

    ws.addEventListener("message", (event) => this.handleSonioxMessage(event));
    ws.addEventListener("close", () => {
      this.wsOpen = false;
      this.stopHeartbeat();
      if (
        !this.intentionalShutdown &&
        this.state !== "stopping" &&
        this.state !== "ended" &&
        this.state !== "idle" &&
        this.state !== "error" &&
        this.state !== "paused"
      ) {
        void transcriptionEventBus.emitConnectionStatus({ status: "disconnected" });
        this.scheduleWsReconnect();
      }
    });
    ws.addEventListener("error", () => {
      this.emitError(
        new Error("Soniox WS error"),
        "soniox_ws_error",
        true
      );
    });
  }

  private scheduleWsReconnect(): void {
    if (this.wsReconnectTimer) return;
    if (this.wsReconnectAttempts >= this.WS_RECONNECT_BACKOFFS_MS.length) {
      this.emitError(
        new Error("无法重新连接转录服务，请结束录制后重试"),
        "ws_reconnect_failed",
        false
      );
      void transcriptionEventBus.emitConnectionStatus({ status: "error" });
      this.setState("error");
      return;
    }
    for (const u of this.currentUtterances.values()) {
      this.emitUtterance(u, true);
      this.finalizeQueue.push(u);
    }
    this.currentUtterances.clear();
    this.scheduleFinalizeFlush();

    this.setState("reconnecting");
    void transcriptionEventBus.emitConnectionStatus({ status: "reconnecting" });
    const delay = this.WS_RECONNECT_BACKOFFS_MS[this.wsReconnectAttempts];
    this.wsReconnectAttempts += 1;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      void this.attemptWsReconnect();
    }, delay);
  }

  private async attemptWsReconnect(): Promise<void> {
    if (this.intentionalShutdown) return;
    if (this.state === "stopping" || this.state === "ended" || this.state === "idle") {
      return;
    }
    try {
      const resp = await fetch("/api/soniox-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!resp.ok) throw new Error(`token mint ${resp.status}`);
      const data = (await resp.json()) as { token?: string };
      if (!data.token) throw new Error("token mint: empty body");
      this.config = { ...this.config, sonioxToken: data.token };

      await this.openSonioxWs();

      this.wsReconnectAttempts = 0;
      this.setState("recording");
      this.emitError(new Error("连接已恢复，转录继续"), "ws_recovered", true);
    } catch {
      this.scheduleWsReconnect();
    }
  }

  private handleSonioxMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let frame: SonioxFrame;
    try {
      frame = JSON.parse(event.data) as SonioxFrame;
    } catch {
      return;
    }

    if (
      typeof window !== "undefined" &&
      (window as unknown as { __debugSoniox?: boolean }).__debugSoniox
    ) {
      if (frame.error_code) {
        console.warn("[Soniox] error", frame.error_code, frame.error_message);
      } else if (frame.tokens && frame.tokens.length > 0) {
        for (const t of frame.tokens) {
          console.log("[Soniox tok]", {
            text: JSON.stringify(t.text),
            is_final: t.is_final,
            lang: t.language,
            spk: t.speaker,
            trans: t.translation_status,
            ms: `${t.start_ms ?? "?"}→${t.end_ms ?? "?"}`,
          });
        }
      }
    }

    if (frame.error_code) {
      this.emitError(
        new Error(frame.error_message ?? `Soniox error ${frame.error_code}`),
        `soniox_${frame.error_code}`,
        true
      );
      return;
    }
    if (frame.finished) {
      for (const u of this.currentUtterances.values()) {
        if (u.sourceFinal || u.transFinal || u.sourcePending || u.transPending) {
          u.sourceFinal += u.sourcePending;
          u.transFinal += u.transPending;
          u.sourcePending = "";
          u.transPending = "";
          this.emitUtterance(u, true);
          this.finalizeQueue.push(u);
        }
      }
      this.currentUtterances.clear();
      for (const queue of this.awaitingTrans.values()) {
        for (const item of queue) {
          this.emitUtterance(item.u, true);
          this.finalizeQueue.push(item.u);
        }
      }
      this.awaitingTrans.clear();
      this.flushFinalizeQueueImmediate();
      return;
    }
    if (!frame.tokens || frame.tokens.length === 0) return;

    const framePending = new Map<
      number | undefined,
      { source: string; trans: string }
    >();
    const finalizedThisFrame: UtteranceBuilder[] = [];
    const touched = new Set<number | undefined>();
    const awaitingTouched = new Set<number | undefined>();
    let awaitingFinalizedThisFrame = false;

    for (const tok of frame.tokens) {
      if (typeof tok.text !== "string") continue;
      const speakerId = parseSpeaker(tok.speaker);
      const startMs = typeof tok.start_ms === "number" ? tok.start_ms : 0;
      const endMs = typeof tok.end_ms === "number" ? tok.end_ms : startMs;
      const isFinal = !!tok.is_final;
      const status = (tok.translation_status ?? "").toLowerCase();
      const isTranslation =
        status !== "" && status !== "original" && status !== "none";

      if (isTranslation) {
        const queue = this.awaitingTrans.get(speakerId);
        if (queue && queue.length > 0) {
          let bestIdx = -1;
          let bestDist = Infinity;
          for (let i = 0; i < queue.length; i++) {
            const c = queue[i].u;
            if (startMs >= c.startMs - 1500 && startMs <= c.endMs + 1500) {
              const dist = Math.abs(startMs - c.startMs);
              if (dist < bestDist) {
                bestIdx = i;
                bestDist = dist;
              }
            }
          }
          if (bestIdx < 0) bestIdx = 0;

          const matched = queue[bestIdx];
          if (tok.text === "<end>") {
            if (isFinal) {
              if (matched.u.transPending && !matched.u.transFinal) {
                matched.u.transFinal = matched.u.transPending;
                matched.u.transPending = "";
              }
              this.emitUtterance(matched.u, true);
              this.finalizeQueue.push(matched.u);
              queue.splice(bestIdx, 1);
              if (queue.length === 0) this.awaitingTrans.delete(speakerId);
              awaitingFinalizedThisFrame = true;
            }
            continue;
          }
          if (isFinal) {
            matched.u.transFinal += tok.text;
            matched.u.endMs = Math.max(matched.u.endMs, endMs);
            awaitingTouched.add(speakerId);
          }
          continue;
        }
      }

      let u = this.currentUtterances.get(speakerId);

      if (!u) {
        u = {
          id: `u-${++this.utteranceCounter}`,
          speakerId,
          startMs,
          endMs,
          sourceFinal: "",
          sourcePending: "",
          consumedSourcePending: "",
          transFinal: "",
          transPending: "",
          consumedTransPending: "",
        };
        this.currentUtterances.set(speakerId, u);
      }
      u.endMs = Math.max(u.endMs, endMs);
      touched.add(speakerId);

      if (tok.text === "<end>") {
        if (isFinal) {
          if (u.transPending && !u.transFinal) {
            u.transFinal = u.transPending;
            u.transPending = "";
          }
          const shouldAwaitTrans =
            this.config.translationMode === "cloud" &&
            this.config.sourceLanguage !== this.config.targetLanguage &&
            u.sourceFinal.trim().length > 0 &&
            u.transFinal.trim().length === 0;
          if (shouldAwaitTrans) {
            const queue = this.awaitingTrans.get(speakerId) ?? [];
            queue.push({ u, awaitingSince: performance.now() });
            this.awaitingTrans.set(speakerId, queue);
            this.currentUtterances.delete(speakerId);
            this.liveTranslate.delete(speakerId);
            this.emitUtterance(u, true);
          } else {
            finalizedThisFrame.push(u);
            this.currentUtterances.delete(speakerId);
            this.liveTranslate.delete(speakerId);
          }
        }
        continue;
      }

      if (isFinal) {
        if (isTranslation) u.transFinal += tok.text;
        else u.sourceFinal += tok.text;
      } else {
        const fp = framePending.get(speakerId) ?? { source: "", trans: "" };
        if (isTranslation) fp.trans += tok.text;
        else fp.source += tok.text;
        framePending.set(speakerId, fp);
      }
    }

    let didSplit = false;
    const isLocalMode = this.config.translationMode === "local";
    for (const speakerId of touched) {
      const u = this.currentUtterances.get(speakerId);
      if (!u) continue;
      const fp = framePending.get(speakerId);
      const rawSourcePending = fp?.source ?? "";
      const normalizedSourcePending = stripConsumedPendingPrefix(
        rawSourcePending,
        u.consumedSourcePending
      );
      if (!normalizedSourcePending.matched) u.consumedSourcePending = "";
      u.sourcePending = normalizedSourcePending.text;
      if (!isLocalMode) {
        const rawTransPending = fp?.trans ?? "";
        const normalizedTransPending = stripConsumedPendingPrefix(
          rawTransPending,
          u.consumedTransPending
        );
        if (!normalizedTransPending.matched) u.consumedTransPending = "";
        u.transPending = normalizedTransPending.text;
      }
      if (this.splitOffCompletedSentences(u)) didSplit = true;
      this.emitUtterance(u, false);
      this.scheduleLiveTranslate(u);
    }

    for (const u of finalizedThisFrame) {
      this.emitUtterance(u, true);
      this.finalizeQueue.push(u);
    }

    for (const speakerId of awaitingTouched) {
      const queue = this.awaitingTrans.get(speakerId);
      if (queue && queue.length > 0) {
        this.emitUtterance(queue[0].u, true);
      }
    }

    let awaitingTimedOut = false;
    const now = performance.now();
    for (const [spk, queue] of this.awaitingTrans) {
      while (
        queue.length > 0 &&
        now - queue[0].awaitingSince > this.AWAIT_TRANS_GRACE_MS
      ) {
        const head = queue.shift()!;
        this.emitUtterance(head.u, true);
        this.finalizeQueue.push(head.u);
        awaitingTimedOut = true;
      }
      if (queue.length === 0) this.awaitingTrans.delete(spk);
    }

    if (
      finalizedThisFrame.length > 0 ||
      didSplit ||
      awaitingFinalizedThisFrame ||
      awaitingTimedOut
    ) {
      this.scheduleFinalizeFlush();
    }
  }

  private splitOffCompletedSentences(u: UtteranceBuilder): boolean {
    const sourceFinalLength = u.sourceFinal.length;
    const sourceText = u.sourceFinal + u.sourcePending;
    const srcSentences = splitSentenceSpans(sourceText);
    if (srcSentences.length < 2) return false;
    const transSentences = splitSentences(u.transFinal);
    if (transSentences.length > 0 && transSentences.length !== srcSentences.length) {
      return false;
    }
    const tailIndex = srcSentences.length - 1;
    const tailStart = srcSentences[tailIndex].start;
    const splitSource = sourceText.slice(0, tailStart).trim();
    if (!splitSource) return false;

    const splitOff: UtteranceBuilder = {
      id: u.id,
      speakerId: u.speakerId,
      startMs: u.startMs,
      endMs: u.endMs,
      sourceFinal: splitSource,
      sourcePending: "",
      consumedSourcePending: "",
      transFinal: transSentences.slice(0, tailIndex).join(" "),
      transPending: "",
      consumedTransPending: "",
    };
    u.id = `u-${++this.utteranceCounter}`;
    if (tailStart >= sourceFinalLength) {
      const consumedFromPending = sourceText
        .slice(sourceFinalLength, tailStart)
        .trimStart();
      if (consumedFromPending) {
        u.consumedSourcePending += consumedFromPending;
      }
      u.sourceFinal = "";
      u.sourcePending = sourceText.slice(tailStart).trimStart();
    } else {
      u.sourceFinal = sourceText.slice(tailStart, sourceFinalLength);
      u.sourcePending = sourceText.slice(sourceFinalLength);
    }
    u.transFinal = transSentences[tailIndex] ?? "";
    u.transPending = "";
    u.startMs = u.endMs;
    this.emitUtterance(splitOff, true);
    this.finalizeQueue.push(splitOff);
    return true;
  }

  private scheduleLiveTranslate(u: UtteranceBuilder): void {
    if (this.config.translationMode !== "local") return;
    const source = (u.sourceFinal + u.sourcePending).trim();
    if (!source) return;
    const speakerKey = u.speakerId;
    const state =
      this.liveTranslate.get(speakerKey) ??
      { lastTranslated: "", timer: null, inFlight: false };
    this.liveTranslate.set(speakerKey, state);
    if (state.lastTranslated === source) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.timer = setTimeout(async () => {
      state.timer = null;
      if (state.inFlight) return;
      const live = this.currentUtterances.get(speakerKey);
      if (live !== u) return;
      const latest = (u.sourceFinal + u.sourcePending).trim();
      if (!latest || latest === state.lastTranslated) return;
      state.inFlight = true;
      try {
        const translated = await this.translateAutoDirection(latest);
        if (translated == null) return;
        if (this.currentUtterances.get(speakerKey) !== u) return;
        state.lastTranslated = latest;
        u.transFinal = "";
        u.transPending = translated;
        this.emitUtterance(u, false);
      } catch {
        /* swallow */
      } finally {
        state.inFlight = false;
        const after = this.currentUtterances.get(speakerKey);
        if (after === u) {
          const now = (u.sourceFinal + u.sourcePending).trim();
          if (now && now !== state.lastTranslated) {
            this.scheduleLiveTranslate(u);
          }
        }
      }
    }, 350);
  }

  private emitUtterance(u: UtteranceBuilder, isFinal: boolean): void {
    const sourceText = (u.sourceFinal + u.sourcePending).trim();
    const translatedText = (u.transFinal + u.transPending).trim();
    if (!sourceText && !translatedText) return;

    if (!isFinal) {
      const utt: Utterance = {
        id: u.id,
        speakerId: u.speakerId,
        startMs: u.startMs,
        endMs: u.endMs,
        sourceText,
        translatedText,
        isFinal: false,
      };
      this.publishUtterance(utt);
      return;
    }

    const sourceSentences = splitSentences(sourceText);
    const transSentences = splitSentences(translatedText);
    const canPair =
      sourceSentences.length > 1 &&
      sourceSentences.length === transSentences.length;

    if (canPair) {
      for (let i = 0; i < sourceSentences.length; i++) {
        const utt: Utterance = {
          id: i === 0 ? u.id : `${u.id}-s${i}`,
          speakerId: u.speakerId,
          startMs: u.startMs,
          endMs: u.endMs,
          sourceText: sourceSentences[i],
          translatedText: transSentences[i] ?? "",
          isFinal: true,
        };
        this.publishUtterance(utt);
      }
    } else {
      const utt: Utterance = {
        id: u.id,
        speakerId: u.speakerId,
        startMs: u.startMs,
        endMs: u.endMs,
        sourceText,
        translatedText,
        isFinal: true,
      };
      this.publishUtterance(utt);
    }
  }

  /**
   * Fan out an utterance to the EventBus (which feeds the Zustand store)
   * and to the local listener (which the live-share plugin uses to
   * mirror utterances to the share channel).
   */
  private publishUtterance(utt: Utterance): void {
    if (utt.isFinal) {
      void transcriptionEventBus.emitFinalTranscript({
        segmentId: utt.id,
        text: utt.sourceText,
        speaker: utt.speakerId,
        startMs: utt.startMs,
        endMs: utt.endMs,
      });
      if (utt.translatedText) {
        void transcriptionEventBus.emitFinalTranslation({
          segmentId: utt.id,
          translatedText: utt.translatedText,
        });
      }
    } else {
      void transcriptionEventBus.emitPartialTranscript({
        text: utt.sourceText,
        speaker: utt.speakerId,
      });
      if (utt.translatedText) {
        void transcriptionEventBus.emitPartialTranslation({
          text: utt.translatedText,
          speaker: utt.speakerId,
        });
      }
    }
    try {
      this.listeners.onUtterance?.(utt, utt.isFinal);
    } catch {
      /* swallow */
    }
  }

  // ---- batched POST of finalized utterances as segments ----

  private scheduleFinalizeFlush(): void {
    if (this.finalizeTimer) return;
    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      void this.flushFinalizeQueue();
    }, 250);
  }

  private flushFinalizeQueueImmediate(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    void this.flushFinalizeQueue();
  }

  private async flushFinalizeQueue(): Promise<void> {
    if (this.finalizeQueue.length === 0) return;
    const utterances = this.finalizeQueue.splice(0, this.finalizeQueue.length);

    const segments: CreateSegmentBody[] = [];
    const indexToUtteranceId = new Map<number, string>();
    for (const u of utterances) {
      const sourceText = u.sourceFinal.trim();
      const translatedText = u.transFinal.trim();
      if (!sourceText && !translatedText) continue;
      const idx = this.segmentIndex++;
      indexToUtteranceId.set(idx, u.id);
      segments.push({
        segmentIndex: idx,
        audioStartMs: u.startMs,
        audioEndMs: u.endMs,
        speakerId: u.speakerId,
        sourceText: sourceText || translatedText,
        translatedText: translatedText || null,
        isFinal: true,
      });
    }
    if (segments.length === 0) return;

    try {
      const res = await fetch(
        `/api/transcription/sessions/${encodeURIComponent(
          this.config.sessionId
        )}/segments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments }),
        }
      );
      if (!res.ok) {
        throw new Error(`segments POST status=${res.status}`);
      }
      const body = (await res.json()) as
        | SegmentDTO[]
        | { segments?: SegmentDTO[]; items?: SegmentDTO[] };
      const segs = Array.isArray(body)
        ? body
        : body.segments ?? body.items ?? [];
      for (const seg of segs) {
        const utteranceId = indexToUtteranceId.get(seg.segmentIndex);
        if (utteranceId) this.segmentToUtterance.set(seg.id, utteranceId);
        try { this.listeners.onSegment?.(seg, utteranceId); } catch { /* swallow */ }
        if (!seg.translatedText && this.config.translationMode === "local") {
          void this.translateLocal(seg);
        }
      }
    } catch (err) {
      this.emitError(err, "segments_post_failed", true);
    }
  }

  // ==========================================================================
  //   AudioWorklet messages
  // ==========================================================================

  private handleWorkletMessage(msg: WorkletInboundMessage): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "level") {
      // level emission is informational and currently has no bus channel —
      // keep silent (UI uses the analyser directly via getMediaStream).
      return;
    }
    if (msg.type === "pcm") {
      if (this.state === "paused") return;
      if (this.wsOpen && this.ws) {
        try {
          this.ws.send(msg.buffer);
          this.lastAudioSendAt = performance.now();
        } catch (err) {
          this.emitError(err, "ws_send_failed", true);
        }
      } else {
        if (this.pcmQueue.length < 200) {
          this.pcmQueue.push(msg.buffer);
        }
      }
    }
  }

  // ==========================================================================
  //   MediaRecorder — emits chunks; persistence plugin owns the upload pipeline
  // ==========================================================================

  private startMediaRecorder(): void {
    if (!this.stream) throw new Error("No stream for MediaRecorder");
    const preferred = "audio/webm;codecs=opus";
    const fallback = "audio/webm";
    const supported =
      typeof MediaRecorder !== "undefined" &&
      typeof MediaRecorder.isTypeSupported === "function";
    let mime = fallback;
    if (supported && MediaRecorder.isTypeSupported(preferred)) {
      mime = preferred;
    } else if (supported && MediaRecorder.isTypeSupported(fallback)) {
      mime = fallback;
    }
    this.mediaMime = mime;

    const audioOnly = new MediaStream(this.stream.getAudioTracks());
    const recorder = new MediaRecorder(audioOnly, { mimeType: mime });
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const blob = ev.data;
      const idx = this.chunkIndex++;
      const prevAt = this.lastChunkAtMs;
      const nowMs = performance.now();
      this.lastChunkAtMs = nowMs;
      const elapsedSec =
        prevAt === null
          ? (this.config.uploadIntervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS) / 1000
          : Math.max(0, (nowMs - prevAt) / 1000);
      const contentType = blob.type || this.mediaMime;
      try {
        this.listeners.onChunk?.({
          sessionId: this.config.sessionId,
          chunkIndex: idx,
          blob,
          durationSeconds: elapsedSec,
          contentType,
        });
      } catch (err) {
        this.emitError(err, "chunk_listener_failed", true);
      }
    };

    recorder.onerror = (ev) => {
      const detail =
        (ev as unknown as { error?: { message?: string } }).error?.message ??
        "MediaRecorder error";
      this.emitError(new Error(detail), "media_recorder_error", true);
    };

    const interval =
      this.config.uploadIntervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS;
    recorder.start(interval);
  }

  private async stopMediaRecorderAndDrain(): Promise<void> {
    const rec = this.mediaRecorder;
    if (!rec) return;
    if (rec.state === "inactive") return;
    await new Promise<void>((resolve) => {
      rec.addEventListener("stop", () => resolve(), { once: true });
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });
  }

  // ==========================================================================
  //   translation
  // ==========================================================================

  private async translateLocal(seg: SegmentDTO): Promise<void> {
    if (!seg.sourceText) return;
    try {
      const translatedText = await this.translateAutoDirection(seg.sourceText);
      if (translatedText == null) {
        try {
          await this.translateCloud(seg);
        } catch {
          if (!this.translateFallbackWarned) {
            this.translateFallbackWarned = true;
            this.emitError(
              new Error(
                "本地翻译不可用且云端翻译失败（可能 Gemini 配额耗尽）。建议切到「云端翻译」模式（用 Soniox 内置翻译，不消耗 LLM 配额）。"
              ),
              "translator_unavailable",
              true
            );
          }
        }
        return;
      }
      await this.patchSegmentTranslation(seg, translatedText);
    } catch (err) {
      this.emitError(err, "translator_local_failed", true);
    }
  }

  private getOrCreateChromeTranslator(
    src: string,
    tgt: string
  ): Promise<{ translate(text: string): Promise<string> } | null> {
    const key = `${src}->${tgt}`;
    const cached = this.chromeTranslators.get(key);
    if (cached) return cached;
    const T =
      typeof window === "undefined"
        ? undefined
        : ((window as unknown as { Translator?: ChromeTranslator }).Translator);
    if (!T) {
      return Promise.resolve(null);
    }
    const p: Promise<{ translate(text: string): Promise<string> } | null> = (async () => {
      try {
        const a = await T.availability({ sourceLanguage: src, targetLanguage: tgt });
        if (a !== "available" && a !== "downloading") {
          this.chromeTranslators.delete(key);
          return null;
        }
        return await T.create({ sourceLanguage: src, targetLanguage: tgt });
      } catch (err) {
        this.chromeTranslators.delete(key);
        this.emitError(err, "translator_local_failed", true);
        return null;
      }
    })();
    this.chromeTranslators.set(key, p);
    return p;
  }

  private async translateAutoDirection(text: string): Promise<string | null> {
    if (!text) return null;
    const src = this.config.sourceLanguage;
    const tgt = this.config.targetLanguage;
    const srcIsCJK = /^(zh|ja|ko)/i.test(src);
    const tgtIsCJK = /^(zh|ja|ko)/i.test(tgt);
    let from: string;
    let to: string;
    if (srcIsCJK === tgtIsCJK) {
      from = src;
      to = tgt;
    } else {
      const cjkChars = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
      const totalNonSpace = text.replace(/\s+/g, "").length;
      const textIsCJK = totalNonSpace > 0 && cjkChars / totalNonSpace > 0.3;
      [from, to] = textIsCJK === tgtIsCJK ? [tgt, src] : [src, tgt];
    }
    if (from === to) return text;
    const translator = await this.getOrCreateChromeTranslator(from, to);
    if (!translator) return null;
    return translator.translate(text);
  }

  private async translateCloud(seg: SegmentDTO): Promise<void> {
    if (!seg.sourceText) return;
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: seg.sourceText,
          sourceLanguage: this.config.sourceLanguage,
          targetLanguage: this.config.targetLanguage,
          segmentId: seg.id,
        }),
      });
      if (!res.ok) throw new Error(`/api/translate -> ${res.status}`);
      const body = (await res.json()) as { translatedText: string };
      await this.patchSegmentTranslation(seg, body.translatedText);
    } catch (err) {
      this.emitError(err, "translator_cloud_failed", true);
    }
  }

  private async patchSegmentTranslation(
    seg: SegmentDTO,
    translatedText: string
  ): Promise<void> {
    try {
      const res = await fetch(
        `/api/transcription/segments/${encodeURIComponent(seg.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ translatedText }),
        }
      );
      if (!res.ok) {
        throw new Error(`segment PATCH -> ${res.status}`);
      }
      const updated = (await res.json()) as SegmentDTO;
      const utteranceId = this.segmentToUtterance.get(updated.id);
      try { this.listeners.onSegment?.(updated, utteranceId); } catch { /* swallow */ }
      if (utteranceId) {
        // Bridge translation back as a final-utterance update via bus so the
        // store updates the live card. Recorder.ts emitted an `utterance`
        // event for this; here we emit on the typed bus channel.
        void transcriptionEventBus.emitFinalTranscript({
          segmentId: utteranceId,
          text: updated.sourceText,
          speaker: updated.speakerId ?? undefined,
          startMs: updated.audioStartMs,
          endMs: updated.audioEndMs,
        });
        if (updated.translatedText) {
          void transcriptionEventBus.emitFinalTranslation({
            segmentId: utteranceId,
            translatedText: updated.translatedText,
          });
        }
      }
    } catch (err) {
      this.emitError(err, "segment_patch_failed", true);
    }
  }

  // ==========================================================================
  //   misc helpers
  // ==========================================================================

  private setState(next: RecorderState): void {
    if (next === this.state) return;
    this.state = next;
  }

  private computeDurationMs(): number {
    if (this.startedAtMs === null) return 0;
    let paused = this.totalPausedMs;
    if (this.pausedSince !== null) {
      paused += performance.now() - this.pausedSince;
    }
    return Math.max(0, Math.round(performance.now() - this.startedAtMs - paused));
  }

  private emitError(err: unknown, code: string, recoverable: boolean): void {
    const message = err instanceof Error ? err.message : String(err);
    void transcriptionEventBus.emitError({
      code,
      message,
      retriable: recoverable,
    });
    if (!recoverable) {
      this.setState("error");
    }
  }

  private async shutdownInternal(): Promise<void> {
    this.detachDeviceMonitor();
    this.detachVisibilityMonitor();
    this.detachPageHideMonitor();
    this.stopHeartbeat();
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    try {
      this.workletNode?.disconnect();
    } catch { /* ignore */ }
    try {
      this.sourceNode?.disconnect();
    } catch { /* ignore */ }
    try {
      this.analyserNode?.disconnect();
    } catch { /* ignore */ }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.wsOpen = false;
    if (this.audioCtx) {
      try { await this.audioCtx.close(); } catch { /* ignore */ }
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this.stream = null;
    }
    if (this.fileAudioObjectUrl) {
      try { URL.revokeObjectURL(this.fileAudioObjectUrl); } catch { /* ignore */ }
      this.fileAudioObjectUrl = null;
    }
    this.fileAudioEl = null;
    this.mediaRecorder = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.analyserNode = null;
  }
}

// ===========================================================================
//   helpers (mirrored from recorder.ts so transcription-service stands alone)
// ===========================================================================

function parseSpeaker(s: unknown): number | undefined {
  if (s === undefined || s === null) return undefined;
  if (typeof s === "number") return Number.isFinite(s) ? s : undefined;
  if (typeof s === "string") {
    const m = s.match(/(\d+)/);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

function splitSentences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g);
  if (!matches) {
    const t = text.trim();
    return t ? [t] : [];
  }
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

function splitSentenceSpans(text: string): Array<{ text: string; start: number; end: number }> {
  if (!text) return [];
  const spans: Array<{ text: string; start: number; end: number }> = [];
  const re = /[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g;
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    spans.push({
      text: trimmed,
      start: start + leading,
      end: start + raw.length - trailing,
    });
  }
  return spans;
}

function stripConsumedPendingPrefix(
  pending: string,
  consumed: string
): { text: string; matched: boolean } {
  if (!consumed) return { text: pending, matched: true };
  if (pending.startsWith(consumed)) {
    return { text: pending.slice(consumed.length), matched: true };
  }
  const trimmedConsumed = consumed.trimStart();
  const trimmedPending = pending.trimStart();
  if (trimmedConsumed && trimmedPending.startsWith(trimmedConsumed)) {
    return {
      text: trimmedPending.slice(trimmedConsumed.length),
      matched: true,
    };
  }
  return { text: pending, matched: false };
}
