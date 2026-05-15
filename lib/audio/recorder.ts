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
} from "../contracts";
import type {
  PendingTokenGroup,
  SonioxFrame,
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
  private readonly config: RecorderConfig;
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

  // ---- token / segment bookkeeping ----
  private tokenCounter = 0;
  private segmentIndex = 0;
  /** Tokens that arrived as non-final, keyed by speaker. */
  private pendingTokens: Map<number | undefined, PendingTokenGroup> = new Map();
  /** Final tokens not yet flushed to a segment, per speaker. */
  private finalBuffers: Map<
    number | undefined,
    { startMs: number; endMs: number; text: string }
  > = new Map();
  private finalFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- chunk upload pipeline ----
  private mediaRecorder: MediaRecorder | null = null;
  private mediaMime = "audio/webm";
  private chunkIndex = 0;
  private lastChunkAtMs: number | null = null;
  /** Queue of blobs awaiting upload; processed serially so we don't reorder. */
  private chunkUploadQueue: Promise<void> = Promise.resolve();

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
    this.setState("stopping");

    // 1. Stop MediaRecorder, wait for any final dataavailable to land.
    const recorderStopped = this.stopMediaRecorderAndDrain();

    // 2. Tell Soniox we're done sending audio (best-effort, ignore errors).
    this.flushFinalSegmentsImmediate();
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

  destroy(): void {
    // Synchronous best-effort teardown without further events.
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
    if (this.finalFlushTimer) {
      clearTimeout(this.finalFlushTimer);
      this.finalFlushTimer = null;
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
    const wantTranslation =
      this.config.translationMode !== "off" &&
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
        type: "one_way",
        target_language: this.config.targetLanguage,
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

  private handleSonioxMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let frame: SonioxFrame;
    try {
      frame = JSON.parse(event.data) as SonioxFrame;
    } catch {
      return;
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
      this.flushFinalSegmentsImmediate();
      return;
    }
    if (!frame.tokens || frame.tokens.length === 0) return;

    for (const tok of frame.tokens) {
      if (!tok.text) continue;
      const speakerId = parseSpeaker(tok.speaker);
      const startMs = tok.start_ms ?? 0;
      const endMs = tok.end_ms ?? startMs;
      const isFinal = !!tok.is_final;

      const tokenId = `t-${++this.tokenCounter}`;
      this.onEvent({
        token: {
          id: tokenId,
          text: tok.text,
          isFinal,
          speakerId,
          isTranslation:
            tok.translation_status !== undefined &&
            tok.translation_status !== "original",
          startMs,
          endMs,
        },
      });

      if (!isFinal) {
        const group = this.pendingTokens.get(speakerId) ?? {
          speakerId,
          tokens: [],
        };
        group.tokens.push({
          id: tokenId,
          text: tok.text,
          startMs,
          endMs,
        });
        this.pendingTokens.set(speakerId, group);
      } else {
        // Drop pending tokens for this speaker once we get a final.
        this.pendingTokens.delete(speakerId);
        const buf = this.finalBuffers.get(speakerId);
        if (buf) {
          buf.text += tok.text;
          buf.endMs = endMs;
        } else {
          this.finalBuffers.set(speakerId, {
            startMs,
            endMs,
            text: tok.text,
          });
        }
        this.scheduleFinalFlush();
      }
    }
  }

  // ---- coalesce contiguous final tokens into a segment ----

  private scheduleFinalFlush(): void {
    if (this.finalFlushTimer) return;
    this.finalFlushTimer = setTimeout(() => {
      this.finalFlushTimer = null;
      void this.flushFinalSegments();
    }, 250);
  }

  private flushFinalSegmentsImmediate(): void {
    if (this.finalFlushTimer) {
      clearTimeout(this.finalFlushTimer);
      this.finalFlushTimer = null;
    }
    void this.flushFinalSegments();
  }

  private async flushFinalSegments(): Promise<void> {
    if (this.finalBuffers.size === 0) return;
    const groups = [...this.finalBuffers.entries()];
    this.finalBuffers.clear();

    const payload: { segments: CreateSegmentBody[] } = { segments: [] };
    for (const [speakerId, buf] of groups) {
      if (!buf.text.trim()) continue;
      payload.segments.push({
        segmentIndex: this.segmentIndex++,
        audioStartMs: buf.startMs,
        audioEndMs: buf.endMs,
        speakerId: speakerId,
        sourceText: buf.text,
        isFinal: true,
      });
    }
    if (payload.segments.length === 0) return;

    try {
      const res = await fetch(
        `/api/transcription/sessions/${encodeURIComponent(
          this.config.sessionId
        )}/segments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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
        this.onEvent({ segment: seg });
        // Kick off translation if needed.
        if (this.config.translationMode === "local") {
          void this.translateLocal(seg);
        } else if (this.config.translationMode === "cloud") {
          void this.translateCloud(seg);
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
    const { uploadUrl, publicUrl, method, headers, chunkId } = presign as {
      uploadUrl: string;
      publicUrl: string;
      method: "PUT" | "POST";
      headers?: Record<string, string>;
      chunkId: string;
    };

    // 2. PUT (or POST) bytes
    await this.fetchWithRetry(uploadUrl, {
      method,
      headers: headers ?? { "Content-Type": contentType },
      body: blob,
    });

    // 3. Record completion
    await this.fetchJsonWithRetry("/api/audio/chunk-record", {
      sessionId: this.config.sessionId,
      chunkIndex,
      contentType,
      sizeBytes,
      durationSeconds,
      publicUrl,
      storageKey: chunkId,
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
      return;
    }
    try {
      const translator = await T.create({
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
      });
      const translatedText = await translator.translate(seg.sourceText);
      await this.patchSegmentTranslation(seg, translatedText);
    } catch (err) {
      this.emitError(err, "translator_local_failed", true);
    }
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
    if (this.finalFlushTimer) {
      clearTimeout(this.finalFlushTimer);
      this.finalFlushTimer = null;
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
