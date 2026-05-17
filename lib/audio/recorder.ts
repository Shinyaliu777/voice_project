/**
 * Browser-side Recorder.
 *
 * Coordinates four parallel pipelines:
 *
 *   1. mic / system capture (getUserMedia / getDisplayMedia)
 *   2. AudioWorklet "pcm-encoder" → Soniox WebSocket (real-time transcription)
 *   3. MediaRecorder → chunk upload pipeline (durable storage for replay)
 *   4. optional client-side translation (window.Translator / cloud)
 *
 * The class is intentionally event-driven: callers pass an `onEvent`
 * handler and read state/token/segment/error/level events from there.
 */
import type {
  CreateSegmentBody,
  RecorderConfig,
  RecorderError,
  RecorderEvent,
  RecorderState,
  SegmentDTO,
  Utterance,
} from "../contracts";
import type {
  SonioxFrame,
  UtteranceBuilder,
  WorkletInboundMessage,
} from "./types";

// -------- Chrome Translator API shape (lib/translation/chrome-local.ts owns the global) --------

interface ChromeTranslator {
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<{ translate(text: string): Promise<string> }>;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_UPLOAD_INTERVAL_MS = 3000;
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const WORKLET_URL = "/worklets/pcm-encoder.js";

/** Default factory for callers that don't want to think about the constructor. */
export function createRecorder(
  config: RecorderConfig,
  onEvent: (e: RecorderEvent) => void
): Recorder {
  return new Recorder(config, onEvent);
}

export class Recorder {
  // ---- config / callbacks ----
  // `config` is mutable so callers can attach a live-share token *after* the
  // recorder has started (the user typically clicks "share" mid-recording).
  private config: RecorderConfig;
  private readonly onEvent: (e: RecorderEvent) => void;

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
  /** PCM frames buffered until the WS is open. */
  private pcmQueue: ArrayBuffer[] = [];

  // ---- utterance / segment bookkeeping ----
  private utteranceCounter = 0;
  private segmentIndex = 0;
  /** In-flight utterances keyed by speakerId. One per active speaker until <end>. */
  private currentUtterances: Map<number | undefined, UtteranceBuilder> = new Map();
  /** Utterances finalized by <end>, queued for batched POST to /segments. */
  private finalizeQueue: UtteranceBuilder[] = [];
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Maps DB segment id → the in-app utterance id we emitted, so we can fan
   *  a translation PATCH back out as an `utterance` event the UI picks up. */
  private segmentToUtterance: Map<string, string> = new Map();

  // ---- chunk upload pipeline ----
  private mediaRecorder: MediaRecorder | null = null;
  private mediaMime = "audio/webm";
  private chunkIndex = 0;
  private lastChunkAtMs: number | null = null;
  /** Queue of blobs awaiting upload; processed serially so we don't reorder. */
  private chunkUploadQueue: Promise<void> = Promise.resolve();

  // ---- device disconnect / recovery ----
  /** Bound listener attached to the audio track's "ended" event. */
  private trackEndedListener: (() => void) | null = null;
  /** Track currently being monitored — kept so we can detach cleanly. */
  private monitoredTrack: MediaStreamTrack | null = null;
  private deviceRecoveryAttempts = 0;
  private deviceRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEVICE_RECOVERY_MAX_ATTEMPTS = 3;
  private readonly DEVICE_RECOVERY_BACKOFF_MS = 2000;

  // ---- WS reconnect ----
  /** Set true on stop()/destroy() so close handlers don't try to reconnect. */
  private intentionalShutdown = false;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WS_RECONNECT_BACKOFFS_MS = [500, 1500, 3000];

  // ---- Chrome Translator cache ----
  // window.Translator.create() warms up an on-device model — caching the
  // instance across segments turns a 200-500ms-per-segment cold-start into a
  // single one-off init at session start.
  private chromeTranslator: { translate(text: string): Promise<string> } | null = null;
  private chromeTranslatorKey: string | null = null;
  private chromeTranslatorPromise: Promise<{ translate(text: string): Promise<string> } | null> | null = null;

  constructor(config: RecorderConfig, onEvent: (e: RecorderEvent) => void) {
    this.config = config;
    this.onEvent = onEvent;
  }

  // ==========================================================================
  //   public API
  // ==========================================================================

  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`Recorder.start() called from state=${this.state}`);
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
        void this.getOrCreateChromeTranslator();
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

    // 1. Stop MediaRecorder, wait for any final dataavailable to land.
    const recorderStopped = this.stopMediaRecorderAndDrain();

    // 2. Tell Soniox we're done sending audio (best-effort, ignore errors).
    this.flushFinalizeQueueImmediate();
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Soniox accepts an empty binary frame as end-of-stream.
        this.ws.send(new ArrayBuffer(0));
      }
    } catch {
      /* ignore */
    }

    // 3. Wait for queued chunks to flush, then send finalize.
    await recorderStopped.catch(() => undefined);
    await this.chunkUploadQueue.catch(() => undefined);

    const totalDurationMs = this.computeDurationMs();
    try {
      await fetch("/api/audio/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.config.sessionId,
          totalDurationMs,
        }),
      });
    } catch (err) {
      this.emitError(err, "finalize_failed", true);
    }

    await this.shutdownInternal();
    this.setState("ended");
  }

  /**
   * Attach (or clear) a live-share token mid-recording. While set, every
   * utterance + finalized segment is fire-and-forget posted to the share
   * channel so remote viewers see the same transcript.
   */
  setLiveShareToken(token: string | null | undefined): void {
    this.config = {
      ...this.config,
      liveShareToken: token ?? undefined,
    };
  }

  destroy(): void {
    // Synchronous best-effort teardown without further events.
    this.intentionalShutdown = true;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.detachDeviceMonitor();
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
  }

  // ==========================================================================
  //   media capture
  // ==========================================================================

  private async acquireStream(): Promise<void> {
    if (this.config.audioSource === "system") {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        // We have to release the video track we just grabbed.
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(
          "System audio capture returned no audio track; the user likely declined to share audio"
        );
      }
      // We need video to satisfy the API but don't actually use it.
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

  /**
   * Listen for the audio track's "ended" event so we notice when the user
   * unplugs their mic / revokes permission / switches device mid-recording.
   */
  private attachDeviceMonitor(): void {
    this.detachDeviceMonitor();
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return;
    const listener = () => {
      // Reset the listener bookkeeping so re-acquisition can re-attach.
      this.monitoredTrack = null;
      this.trackEndedListener = null;
      // Only react during an active session; ignore if we're shutting down.
      if (this.state === "stopping" || this.state === "ended" || this.state === "idle") {
        return;
      }
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

  /**
   * Try to grab the mic again and splice the new MediaStream into the live
   * audio graph without re-creating the AudioContext or WebSocket. On success
   * the recorder is back to "recording" state in a couple seconds; on repeat
   * failure we surface a terminal error.
   */
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
      this.setState("error");
      return;
    }
    this.deviceRecoveryAttempts += 1;

    try {
      const oldStream = this.stream;
      this.stream = null;
      // Re-run the same acquireStream() path so we honor audioSource etc.
      await this.acquireStream(); // also re-attaches the device monitor on the new track
      if (!this.stream) throw new Error("re-acquire returned no stream");

      // Splice the new stream into the existing audio graph.
      if (this.audioCtx && this.workletNode) {
        try { this.sourceNode?.disconnect(); } catch {}
        const newSource = this.audioCtx.createMediaStreamSource(this.stream);
        this.sourceNode = newSource;
        newSource.connect(this.workletNode);
        if (this.analyserNode) newSource.connect(this.analyserNode);
      }

      // Release the dead stream's tracks (the ended one and any siblings).
      if (oldStream) {
        oldStream.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
      }

      this.deviceRecoveryAttempts = 0;
      this.setState("recording");
      // emitError with a "recovered" code so the UI can show an info toast.
      this.emitError(new Error("麦克风已恢复"), "device_recovered", true);
    } catch {
      // Re-try after a short backoff.
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
    // No connection to ctx.destination — we don't want to monitor playback.
  }

  // ==========================================================================
  //   Soniox WebSocket
  // ==========================================================================

  private async openSonioxWs(): Promise<void> {
    const ws = new WebSocket(SONIOX_WS_URL);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    const sampleRate = this.config.sampleRate ?? DEFAULT_SAMPLE_RATE;
    // Soniox's two-way translation only runs in "cloud" mode. The "local"
    // option means the user explicitly wants on-device Chrome Translator
    // (privacy-first); asking Soniox to also translate would defeat the
    // Translation routing per UI mode:
    //   "off"   — no translation at all
    //   "local" — Chrome's on-device Translator API handles each finalized
    //             segment client-side. No Soniox translation budget burned.
    //   "cloud" — Soniox's built-in two-way translation runs in the same WS
    //             stream so source ↔ translation stay token-aligned. Costs
    //             Soniox translation usage.
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
      // Single language hint — the source. Soniox auto-detects the other side
      // of a two-way translation pair. Strict hints would block borderline
      // pronunciation and stall the stream, so leave at default (off).
      language_hints: [this.config.sourceLanguage],
    };
    if (this.config.transcriptionContext) {
      initConfig.context = this.config.transcriptionContext;
    }
    if (wantTranslation) {
      // Two-way: Soniox auto-detects which side is being spoken and translates
      // into the other one in the same WS stream. Keeps both directions paired
      // via the per-token translation_status field.
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
        // Flush anything that was queued during connection.
        for (const buf of this.pcmQueue) {
          try { ws.send(buf); } catch { /* ignore */ }
        }
        this.pcmQueue = [];
        resolve();
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        reject(new Error("Soniox WebSocket failed to open"));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });

    ws.addEventListener("message", (event) => this.handleSonioxMessage(event));
    ws.addEventListener("close", () => {
      this.wsOpen = false;
      // Auto-reconnect if the close wasn't initiated by us and we're still
      // mid-session. Don't fire during normal stop()/destroy() or while
      // device-recovery is the failure path.
      if (
        !this.intentionalShutdown &&
        this.state !== "stopping" &&
        this.state !== "ended" &&
        this.state !== "idle" &&
        this.state !== "error"
      ) {
        this.scheduleWsReconnect();
      }
    });
    ws.addEventListener("error", () => {
      // Surface but don't tear down — recording can still continue to chunks.
      this.emitError(
        new Error("Soniox WS error"),
        "soniox_ws_error",
        true
      );
    });
  }

  /**
   * On unexpected WS close: finalize anything in flight (Soniox sessions
   * are stateful and don't resume), then back off and re-mint a token +
   * re-open. After WS_RECONNECT_BACKOFFS_MS.length failures we surface a
   * terminal error.
   */
  private scheduleWsReconnect(): void {
    if (this.wsReconnectTimer) return;
    if (this.wsReconnectAttempts >= this.WS_RECONNECT_BACKOFFS_MS.length) {
      this.emitError(
        new Error("无法重新连接转录服务，请结束录制后重试"),
        "ws_reconnect_failed",
        false
      );
      this.setState("error");
      return;
    }
    // Promote whatever was in-flight — Soniox loses state across sessions.
    for (const u of this.currentUtterances.values()) {
      this.emitUtterance(u, true);
      this.finalizeQueue.push(u);
    }
    this.currentUtterances.clear();
    this.scheduleFinalizeFlush();

    this.setState("reconnecting");
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
      // Old keys may have expired during the outage — get a fresh one.
      const resp = await fetch("/api/soniox-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!resp.ok) throw new Error(`token mint ${resp.status}`);
      const data = (await resp.json()) as { token?: string };
      if (!data.token) throw new Error("token mint: empty body");
      this.config = { ...this.config, sonioxToken: data.token };

      // openSonioxWs will re-attach its own close listener that will call
      // scheduleWsReconnect again if the new socket also dies.
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

    // Debug: set `window.__debugSoniox = true` in the browser console before
    // recording to dump every Soniox frame. Helpful for diagnosing why
    // translation tokens aren't appearing.
    if (
      typeof window !== "undefined" &&
      (window as unknown as { __debugSoniox?: boolean }).__debugSoniox
    ) {
      console.log("[Soniox frame]", frame);
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
      // Promote any in-flight utterances to finals before draining.
      for (const u of this.currentUtterances.values()) {
        if (u.sourceFinal || u.transFinal || u.sourcePending || u.transPending) {
          // Treat lingering pending text as final on stream end.
          u.sourceFinal += u.sourcePending;
          u.transFinal += u.transPending;
          u.sourcePending = "";
          u.transPending = "";
          this.emitUtterance(u, true);
          this.finalizeQueue.push(u);
        }
      }
      this.currentUtterances.clear();
      this.flushFinalizeQueueImmediate();
      return;
    }
    if (!frame.tokens || frame.tokens.length === 0) return;

    // Per-speaker pending replacements for this frame. Soniox sends the
    // current in-flight guess as a snapshot, not as a delta, so we collect
    // everything non-final from this frame and assign at the end.
    const framePending = new Map<
      number | undefined,
      { source: string; trans: string }
    >();
    const finalizedThisFrame: UtteranceBuilder[] = [];
    const touched = new Set<number | undefined>();

    for (const tok of frame.tokens) {
      if (typeof tok.text !== "string") continue;
      const speakerId = parseSpeaker(tok.speaker);
      const startMs = typeof tok.start_ms === "number" ? tok.start_ms : 0;
      const endMs = typeof tok.end_ms === "number" ? tok.end_ms : startMs;
      const isFinal = !!tok.is_final;
      const status = (tok.translation_status ?? "").toLowerCase();
      const isTranslation =
        status !== "" && status !== "original" && status !== "none";

      let u = this.currentUtterances.get(speakerId);
      if (!u) {
        u = {
          id: `u-${++this.utteranceCounter}`,
          speakerId,
          startMs,
          endMs,
          sourceFinal: "",
          sourcePending: "",
          transFinal: "",
          transPending: "",
        };
        this.currentUtterances.set(speakerId, u);
      }
      u.endMs = Math.max(u.endMs, endMs);
      touched.add(speakerId);

      // <end> marks utterance boundary — never render it as text.
      if (tok.text === "<end>") {
        if (isFinal) {
          finalizedThisFrame.push(u);
          this.currentUtterances.delete(speakerId);
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

    // Apply this frame's pending snapshot to each still-active utterance.
    let didSplit = false;
    for (const speakerId of touched) {
      const u = this.currentUtterances.get(speakerId);
      if (!u) continue; // finalized this frame
      const fp = framePending.get(speakerId);
      u.sourcePending = fp?.source ?? "";
      u.transPending = fp?.trans ?? "";
      // Before emitting the in-flight state, see if any complete sentences
      // accumulated in finals — if so, spin them off as their own cards so
      // the live block stays short (Soniox doesn't always emit <end> for
      // every sentence boundary on its own).
      if (this.splitOffCompletedSentences(u)) didSplit = true;
      this.emitUtterance(u, false);
    }

    // Emit + queue POST for utterances that hit <end> this frame.
    for (const u of finalizedThisFrame) {
      this.emitUtterance(u, true);
      this.finalizeQueue.push(u);
    }
    if (finalizedThisFrame.length > 0 || didSplit) this.scheduleFinalizeFlush();
  }

  /**
   * If a still-in-flight utterance has accumulated more than one complete
   * sentence in its finals, peel everything except the last sentence off
   * into its own finalized card. Pairs source ↔ translation only when both
   * sides have the same sentence count; otherwise leaves the utterance
   * intact so the alignment stays correct. Returns true when a split
   * happened.
   */
  private splitOffCompletedSentences(u: UtteranceBuilder): boolean {
    const srcSentences = splitSentences(u.sourceFinal);
    if (srcSentences.length < 2) return false;
    const transSentences = splitSentences(u.transFinal);
    // Only split when translation has caught up — otherwise we risk
    // emitting source-only cards while the translation lags one sentence behind.
    if (transSentences.length > 0 && transSentences.length !== srcSentences.length) {
      return false;
    }
    const tailIndex = srcSentences.length - 1;
    const splitOff: UtteranceBuilder = {
      id: u.id,
      speakerId: u.speakerId,
      startMs: u.startMs,
      endMs: u.endMs,
      sourceFinal: srcSentences.slice(0, tailIndex).join(" "),
      sourcePending: "",
      transFinal: transSentences.slice(0, tailIndex).join(" "),
      transPending: "",
    };
    // The remaining "tail" sentence becomes the new in-flight utterance.
    u.id = `u-${++this.utteranceCounter}`;
    u.sourceFinal = srcSentences[tailIndex];
    u.sourcePending = "";
    u.transFinal = transSentences[tailIndex] ?? "";
    u.transPending = "";
    u.startMs = u.endMs;
    this.emitUtterance(splitOff, true);
    this.finalizeQueue.push(splitOff);
    return true;
  }

  private emitUtterance(u: UtteranceBuilder, isFinal: boolean): void {
    const sourceText = (u.sourceFinal + u.sourcePending).trim();
    const translatedText = (u.transFinal + u.transPending).trim();
    if (!sourceText && !translatedText) return;

    // While the utterance is in-flight, render it as a single growing card.
    // Only after <end> finalize do we split into sentence-level cards.
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
      this.onEvent({ utterance: utt });
      this.pushLiveShare({ type: "utterance", utterance: utt });
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
        this.onEvent({ utterance: utt });
        this.pushLiveShare({ type: "utterance", utterance: utt });
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
      this.onEvent({ utterance: utt });
      this.pushLiveShare({ type: "utterance", utterance: utt });
    }
  }

  /**
   * Fire-and-forget push to the live-share channel. We deliberately do not
   * await; transcript propagation must not block the recording pipeline. Push
   * failures surface as a recoverable error but otherwise do nothing.
   */
  private pushLiveShare(payload: object): void {
    const token = this.config.liveShareToken;
    if (!token) return;
    void fetch(`/api/live-share/${encodeURIComponent(token)}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch((err) => {
      this.emitError(err, "live_share_push_failed", true);
    });
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
        | { segments: SegmentDTO[] };
      const segs = Array.isArray(body) ? body : body.segments ?? [];
      for (const seg of segs) {
        const utteranceId = indexToUtteranceId.get(seg.segmentIndex);
        if (utteranceId) this.segmentToUtterance.set(seg.id, utteranceId);
        this.onEvent({ segment: seg });
        this.pushLiveShare({ type: "segment", segment: seg });
        // Translation strategy:
        // - "cloud" mode: Soniox's two-way stream already delivered translation
        //   in parallel with the source tokens, so we DON'T re-translate. A
        //   /api/translate fallback here would only add 400-800ms for nothing.
        // - "local" mode: Soniox wasn't asked to translate (privacy), so we
        //   run Chrome Translator client-side. Cached translator makes this
        //   ~50ms after the first segment of the session.
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
      this.onEvent({ level: msg.value });
      return;
    }
    if (msg.type === "pcm") {
      if (this.state === "paused") return; // drop PCM while paused
      if (this.wsOpen && this.ws) {
        try {
          this.ws.send(msg.buffer);
        } catch (err) {
          this.emitError(err, "ws_send_failed", true);
        }
      } else {
        // Buffer early PCM until the WS is open. Cap so we don't OOM.
        if (this.pcmQueue.length < 200) {
          this.pcmQueue.push(msg.buffer);
        }
      }
    }
  }

  // ==========================================================================
  //   MediaRecorder + chunk upload pipeline
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

    // Use only the audio tracks; otherwise system-audio capture will include video.
    const audioOnly = new MediaStream(this.stream.getAudioTracks());
    const recorder = new MediaRecorder(audioOnly, { mimeType: mime });
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const blob = ev.data;
      // Each blob is one chunk; queue serially so we keep ordering.
      const idx = this.chunkIndex++;
      const prevAt = this.lastChunkAtMs;
      const nowMs = performance.now();
      this.lastChunkAtMs = nowMs;
      const elapsedSec =
        prevAt === null
          ? (this.config.uploadIntervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS) / 1000
          : Math.max(0, (nowMs - prevAt) / 1000);
      this.chunkUploadQueue = this.chunkUploadQueue.then(() =>
        this.uploadChunk(idx, blob, elapsedSec).catch((err) => {
          this.emitError(err, "chunk_upload_failed", true);
        })
      );
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

  private async uploadChunk(
    chunkIndex: number,
    blob: Blob,
    durationSeconds: number
  ): Promise<void> {
    const contentType = blob.type || this.mediaMime;
    const sizeBytes = blob.size;

    // 1. Presign
    const presign = await this.fetchJsonWithRetry(
      "/api/audio/chunk-presign",
      {
        sessionId: this.config.sessionId,
        chunkIndex,
        contentType,
        sizeBytes,
      }
    );
    const { uploadUrl, publicUrl, method, headers, storageKey } = presign as {
      uploadUrl: string;
      publicUrl: string;
      method: "PUT" | "POST";
      headers?: Record<string, string>;
      chunkId: string;
      storageKey: string;
    };

    // 2. PUT (or POST) bytes
    await this.fetchWithRetry(uploadUrl, {
      method,
      headers: headers ?? { "Content-Type": contentType },
      body: blob,
    });

    // 3. Record completion — use the actual storage key so finalize can find
    // the file. (The earlier code passed chunkId, a random UUID, which was
    // never the real path — concat failed and the session ended up "error".)
    await this.fetchJsonWithRetry("/api/audio/chunk-record", {
      sessionId: this.config.sessionId,
      chunkIndex,
      contentType,
      sizeBytes,
      durationSeconds,
      publicUrl,
      storageKey,
    });
  }

  private async fetchJsonWithRetry(
    url: string,
    body: unknown
  ): Promise<unknown> {
    const res = await this.fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(url, init);
        if (res.ok) return res;
        if (res.status < 500 || attempt === 1) {
          const text = await safeText(res);
          throw new Error(
            `${init.method ?? "GET"} ${url} -> ${res.status}: ${text}`
          );
        }
      } catch (err) {
        if (attempt === 1) throw err;
      }
      // back off briefly before retrying
      await new Promise((r) => setTimeout(r, 300));
    }
    // Unreachable
    throw new Error(`fetchWithRetry exhausted retries for ${url}`);
  }

  // ==========================================================================
  //   translation
  // ==========================================================================

  private async translateLocal(seg: SegmentDTO): Promise<void> {
    if (!seg.sourceText) return;
    try {
      const translator = await this.getOrCreateChromeTranslator();
      if (!translator) {
        // Chrome's Translator API isn't usable. Don't silently fail —
        // surface a clear, recoverable error so the UI can prompt the user
        // to switch to 云端 (Soniox two-way) instead.
        this.emitError(
          new Error(
            "本地翻译不可用：请切换到 云端 模式（用 Soniox 内置翻译），" +
              "或在 chrome://flags/#translation-api 启用浏览器原生翻译。"
          ),
          "translator_unavailable",
          true
        );
        return;
      }
      const translatedText = await translator.translate(seg.sourceText);
      await this.patchSegmentTranslation(seg, translatedText);
    } catch (err) {
      this.emitError(err, "translator_local_failed", true);
    }
  }

  /**
   * Returns a cached Chrome Translator for the current source/target pair.
   * Creating a Translator triggers an on-device model warmup; we want to do
   * that exactly once per session, not once per segment.
   */
  private getOrCreateChromeTranslator(): Promise<{ translate(text: string): Promise<string> } | null> {
    const key = `${this.config.sourceLanguage}->${this.config.targetLanguage}`;
    if (this.chromeTranslator && this.chromeTranslatorKey === key) {
      return Promise.resolve(this.chromeTranslator);
    }
    if (this.chromeTranslatorPromise && this.chromeTranslatorKey === key) {
      return this.chromeTranslatorPromise;
    }
    const T =
      typeof window === "undefined"
        ? undefined
        : ((window as unknown as { Translator?: ChromeTranslator }).Translator);
    if (!T) {
      this.emitError(
        new Error("window.Translator is unavailable in this browser"),
        "translator_unavailable",
        true
      );
      return Promise.resolve(null);
    }
    this.chromeTranslator = null;
    this.chromeTranslatorKey = key;
    this.chromeTranslatorPromise = T.create({
      sourceLanguage: this.config.sourceLanguage,
      targetLanguage: this.config.targetLanguage,
    })
      .then((tr) => {
        this.chromeTranslator = tr;
        return tr;
      })
      .catch((err) => {
        this.chromeTranslatorPromise = null;
        this.emitError(err, "translator_local_failed", true);
        return null;
      });
    return this.chromeTranslatorPromise;
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
      this.onEvent({ segment: updated });
      this.pushLiveShare({ type: "segment", segment: updated });
      // Bridge the translation back to the live utterance card the UI is
      // rendering. Without this the Card never re-renders with translated
      // text because the UI listens for `utterance` events, not segment ones.
      const utteranceId = this.segmentToUtterance.get(updated.id);
      if (utteranceId) {
        this.onEvent({
          utterance: {
            id: utteranceId,
            speakerId: updated.speakerId ?? undefined,
            startMs: updated.audioStartMs,
            endMs: updated.audioEndMs,
            sourceText: updated.sourceText,
            translatedText: updated.translatedText ?? "",
            isFinal: true,
          },
        });
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
    this.onEvent({ state: next });
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
    const e: RecorderError = { code, message, recoverable };
    this.onEvent({ error: e });
    if (!recoverable) {
      this.setState("error");
    }
  }

  private async shutdownInternal(): Promise<void> {
    this.detachDeviceMonitor();
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
    this.mediaRecorder = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.analyserNode = null;
  }
}

function parseSpeaker(s: unknown): number | undefined {
  if (s === undefined || s === null) return undefined;
  if (typeof s === "number") return Number.isFinite(s) ? s : undefined;
  if (typeof s === "string") {
    // Soniox sometimes returns "spk-1" or "1"; pull digits if present.
    const m = s.match(/(\d+)/);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

/**
 * Split a finalized utterance text into sentence-sized pieces. Soniox emits
 * <end> at prosody pauses, which can span multiple sentences when the speaker
 * runs them together. Splitting client-side keeps the UI cards short and
 * paired neatly with their translation.
 */
function splitSentences(text: string): string[] {
  if (!text) return [];
  // Match: a run of non-terminator chars optionally followed by one or more
  // terminators (Latin .!? and CJK 。！？). Also capture a trailing fragment
  // without a terminator.
  const matches = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g);
  if (!matches) {
    const t = text.trim();
    return t ? [t] : [];
  }
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}
