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
import { getAudioLocalCache } from "./local-cache";
import {
  TranslationQueue,
  makeTranslationJobId,
} from "./translation-queue";

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
  /** performance.now() of the last binary frame we sent on the Soniox WS. */
  private lastAudioSendAt = 0;
  /** Periodic timer that keeps Soniox alive during silence — without it the
   *  server 408s the stream after a few seconds of no input. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
  /** Translation pipeline for "local" mode. Replaces the previous
   *  setTimeout(350) per-speaker debounce — lecsync's two-priority
   *  queue (decompiled in lib/audio/translation-queue.ts) cuts the
   *  perceived latency from ~450ms to ~100-200ms because the API
   *  call itself is the throttle interval, not a fixed timer. */
  private translationQueue: TranslationQueue | null = null;
  /** Most recently enqueued source-text per speaker. Used to skip
   *  duplicate enqueues when the source hasn't changed (saves a wasted
   *  translator call when Soniox re-emits the same partial). */
  private lastEnqueuedSourceBySpeaker: Map<number | undefined, string> =
    new Map();

  // ---- chunk upload pipeline ----
  private mediaRecorder: MediaRecorder | null = null;
  private mediaMime = "audio/webm";
  private chunkIndex = 0;
  private lastChunkAtMs: number | null = null;
  /** Queue of blobs awaiting upload; processed serially so we don't reorder. */
  private chunkUploadQueue: Promise<void> = Promise.resolve();
  /** Most recent chunk emitted by MediaRecorder. Held in memory so the
   *  pagehide handler can sendBeacon it during tab unload — IndexedDB is
   *  the durable backup, sendBeacon is the fast best-effort path while
   *  the page still has process state. Cleared after a chunk uploads
   *  successfully through the normal pipeline. */
  private lastInFlightChunk: {
    chunkIndex: number;
    blob: Blob;
    durationSeconds: number;
    contentType: string;
  } | null = null;
  /** Bound pagehide listener; kept so we can remove it on shutdown. */
  private boundPageHideHandler: (() => void) | null = null;

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

  // ---- live-share WebSocket ----
  // When a viewer joins via /share/live/<token>, host opens a WS to push
  // utterance/segment frames in realtime. Server fans them out to all
  // viewers connected on the same token. WS is best-effort — if it
  // can't connect or drops, pushLiveShare() silently falls back to the
  // existing HTTP POST path so transcripts still reach viewers via the
  // store-and-poll route. Same backoff schedule as the Soniox WS.
  private liveShareWs: WebSocket | null = null;
  private liveShareWsState: "closed" | "connecting" | "open" | "failed" =
    "closed";
  private liveShareWsReconnectAttempts = 0;
  private liveShareWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly LIVE_SHARE_WS_RECONNECT_BACKOFFS_MS = [500, 1500, 3000];

  // ---- cloud translation lag bridge ----
  // Soniox's two_way translation tokens for a sentence routinely arrive
  // AFTER the source <end> token closes that sentence — sometimes by
  // multiple frames. The naive flow deleted the utterance on source
  // <end>, then the lagging translation tokens found no matching
  // currentUtterances entry and got attributed to the NEXT sentence,
  // producing visible misalignment: every card showed the previous
  // sentence's translation. Reproduces obviously in Speaker-2 sequences
  // like "你在这边等着 / 谁 / 哒哒哒" where the user saw
  // "You wait over here" beside "谁?" and "Who?" beside "哒哒哒".
  //
  // Fix: when the source <end> fires in cloud mode but transFinal is
  // still empty, park the utterance in awaitingTrans (per-speaker
  // FIFO queue) instead of finalizing. Subsequent translation tokens
  // for that speaker fill the queue head. Real finalize happens when
  // (a) translation stream emits its own <end>, or (b) grace timeout
  // elapses — capped at AWAIT_TRANS_GRACE_MS so a missing translation
  // can't stall the segment POST indefinitely.
  private awaitingTrans: Map<
    number | undefined,
    Array<{ u: UtteranceBuilder; awaitingSince: number }>
  > = new Map();
  private readonly AWAIT_TRANS_GRACE_MS = 3000;

  // ---- file-mode audio source ----
  // When audioSource === "file", these hold the off-DOM <audio>
  // element we play the user's uploaded file through and the blob URL
  // we created for it. Both are cleaned up in shutdownInternal so the
  // browser doesn't leak the file's bytes after the session ends.
  private fileAudioEl: HTMLAudioElement | null = null;
  private fileAudioObjectUrl: string | null = null;

  // ---- page visibility ----
  // When the tab is hidden the browser throttles setInterval to ≤1 Hz, and
  // some platforms suspend the AudioContext entirely, so PCM stops flowing
  // to Soniox. We can't beat the throttle in the background, but we *can*
  // recover promptly when the user comes back: resume the AudioContext if
  // suspended, nudge the WS, and flush any pending Chrome-translator work
  // that the setTimeout debounce missed while throttled.
  private boundVisibilityHandler: (() => void) | null = null;
  private boundAudioCtxStateChange: (() => void) | null = null;

  // ---- Chrome Translator cache ----
  // window.Translator.create() warms up an on-device model — caching the
  // instance across segments turns a 200-500ms-per-segment cold-start into a
  // single one-off init. We cache BOTH directions (src→tgt and tgt→src) so
  // bilingual conversations get translated the right way without reloading
  // the model when the speaker switches language.
  private chromeTranslators: Map<
    string,
    Promise<{ translate(text: string): Promise<string> } | null>
  > = new Map();

  /** Set after the first cloud-fallback failure so we don't spam toasts. */
  private translateFallbackWarned = false;

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
        // Prefetch both directions so the speaker can switch language
        // mid-session without the first switch eating a 200-500ms model
        // warmup.
        void this.getOrCreateChromeTranslator(
          this.config.sourceLanguage,
          this.config.targetLanguage
        );
        void this.getOrCreateChromeTranslator(
          this.config.targetLanguage,
          this.config.sourceLanguage
        );
        this.setupTranslationQueue();
      }

      this.attachVisibilityMonitor();
      this.attachPageHideMonitor();

      // File mode: kick off playback so captureStream starts emitting
      // frames. Must happen AFTER buildAudioGraph + openSonioxWs so we
      // don't lose the first second to setup latency.
      if (this.config.audioSource === "file" && this.fileAudioEl) {
        try {
          await this.fileAudioEl.play();
        } catch (err) {
          // Autoplay can be blocked if the page hasn't received a user
          // gesture yet — but the file-pick click IS a user gesture, so
          // this should never trigger in practice. Surface if it does.
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

    // 1. Stop MediaRecorder, wait for any final dataavailable to land.
    const recorderStopped = this.stopMediaRecorderAndDrain();

    // 2. Tell Soniox we're done sending audio (best-effort, ignore errors).
    // Drain any utterances still waiting for lagging translation —
    // without this, sentences that finalized in cloud mode within the
    // last few seconds of recording would never get POSTed.
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
        // Soniox accepts an empty binary frame as end-of-stream.
        this.ws.send(new ArrayBuffer(0));
      }
    } catch {
      /* ignore */
    }

    // 3. Wait for queued chunks to flush, then send finalize.
    await recorderStopped.catch(() => undefined);
    await this.chunkUploadQueue.catch(() => undefined);

    // 3a. Re-upload any chunks still pending in IndexedDB.
    //
    // Without this, a single failed chunk-record POST (network blip)
    // would leave that chunk in IDB with uploaded=false. The DB row
    // for it never gets written, so when finalize runs server-side
    // it concatenates only the chunks that DID land — producing
    // audio shorter than the transcript. That's the "录音和转录不一致"
    // failure mode lecsync's triggerMerge guards against by waiting
    // for `getPendingChunks().length === 0` before calling finalize.
    const allUploaded = await this.flushPendingChunksFromCache(
      this.config.sessionId
    );
    if (!allUploaded) {
      // Bail without finalize. Session stays in "uploading" status;
      // boot-time recovery in RecorderLane will retry on the next
      // page load and the user can re-trigger finalize from the
      // detail page's "完成上传" button.
      this.emitError(
        new Error(
          "部分音频块未能上传，已保留供下次自动恢复。请稍后从历史记录页的「完成上传」按钮重试。"
        ),
        "finalize_deferred_pending_chunks",
        true
      );
      await this.shutdownInternal();
      this.setState("ended");
      return;
    }

    const totalDurationMs = this.computeDurationMs();
    let finalizeOk = false;
    try {
      const resp = await fetch("/api/audio/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.config.sessionId,
          totalDurationMs,
        }),
      });
      finalizeOk = resp.ok;
    } catch (err) {
      this.emitError(err, "finalize_failed", true);
    }

    // Only drop the IndexedDB rows if the server confirmed finalize.
    // If finalize failed, keep them so the next session boot can retry
    // any chunks that didn't make it.
    if (finalizeOk) {
      void getAudioLocalCache()
        .clearSession(this.config.sessionId)
        .catch(() => {});
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
    const prev = this.config.liveShareToken;
    const next = token ?? undefined;
    this.config = {
      ...this.config,
      liveShareToken: next,
    };
    if (prev === next) return;
    // Tear down any existing WS — either token changed or token cleared.
    this.closeLiveShareWs();
    if (next) {
      // Open optimistically — push paths fall back to POST until it
      // resolves. Skip in non-browser environments (SSR safety).
      if (typeof window !== "undefined" && typeof WebSocket !== "undefined") {
        this.openLiveShareWs();
      }
    }
  }

  destroy(): void {
    // Synchronous best-effort teardown without further events.
    this.intentionalShutdown = true;
    this.stopHeartbeat();
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.closeLiveShareWs();
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
  }

  // ==========================================================================
  //   media capture
  // ==========================================================================

  private async acquireStream(): Promise<void> {
    if (this.config.audioSource === "file") {
      if (!this.config.audioFile) {
        throw new Error(
          "audioSource=file but no audioFile in RecorderConfig"
        );
      }
      // Play the file through an off-DOM <audio> element and tap its
      // output stream. Same MediaStream interface as getUserMedia /
      // getDisplayMedia so every downstream path (worklet, level meter,
      // MediaRecorder chunk upload, Soniox WS) works without changes.
      const url = URL.createObjectURL(this.config.audioFile);
      const audioEl = document.createElement("audio");
      audioEl.src = url;
      // Some browsers require crossOrigin to be set BEFORE src for
      // captureStream to be allowed; blob URLs are same-origin so this
      // is defensive.
      audioEl.crossOrigin = "anonymous";
      audioEl.preload = "auto";
      // Wait for metadata so captureStream gives us a stream with the
      // correct sample rate / channel count. Without this captureStream
      // can return a track that never emits frames.
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
      // When playback finishes, stop the recording session automatically
      // so the user doesn't have to click "结束录制" themselves.
      audioEl.addEventListener(
        "ended",
        () => {
          if (this.state === "recording" || this.state === "paused") {
            void this.stop();
          }
        },
        { once: true }
      );
      // Don't attach device monitor — the audio element doesn't fire
      // "ended" on the track for the same reasons a real mic does.
      return;
    }

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
   * Listen for `visibilitychange` and AudioContext `statechange` so we can
   * recover the moment the tab returns from background. The browser throttles
   * setInterval to ≤ 1 Hz in hidden tabs and may suspend the AudioContext, so
   * heartbeat + worklet PCM both pause — Soniox eventually 408s and Chrome
   * Translator's setTimeout(350) debounce never fires. We can't fight the
   * throttle, but we can make the resume snappy.
   */
  private attachVisibilityMonitor(): void {
    if (typeof document === "undefined") return;
    this.detachVisibilityMonitor();

    this.boundVisibilityHandler = () => {
      if (document.hidden) return;
      void this.handleVisibilityReturn();
    };
    document.addEventListener("visibilitychange", this.boundVisibilityHandler);

    // Also react to AudioContext state changes. Chrome will occasionally flip
    // an AudioContext to "suspended" without an explicit visibility transition
    // (e.g. system audio mode, focus loss); the statechange listener catches
    // those cases too.
    if (this.audioCtx) {
      this.boundAudioCtxStateChange = () => {
        if (
          this.audioCtx?.state === "suspended" &&
          typeof document !== "undefined" &&
          !document.hidden &&
          this.state !== "paused" &&
          this.state !== "stopping" &&
          this.state !== "ended"
        ) {
          this.audioCtx.resume().catch(() => {});
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
   * Best-effort flush of the most recent in-flight chunk during tab
   * unload. The normal upload pipeline (presign → PUT → chunk-record)
   * is three round-trips and won't survive a closing page, so we use
   * `navigator.sendBeacon` to POST the chunk bytes + metadata to a
   * single-shot endpoint. IndexedDB still has the chunk too — if the
   * beacon fails, boot-time recovery on the next session load picks
   * up the slack.
   *
   * `pagehide` is the right event (`beforeunload` is unreliable on
   * mobile + restricts beacons; `unload` doesn't fire on
   * back-forward-cache restore). Triggered on tab close, navigation,
   * and crash-recovery transitions.
   */
  private attachPageHideMonitor(): void {
    if (typeof window === "undefined") return;
    this.detachPageHideMonitor();
    this.boundPageHideHandler = () => {
      const chunk = this.lastInFlightChunk;
      if (!chunk) return;
      try {
        const fd = new FormData();
        fd.append("sessionId", this.config.sessionId);
        fd.append("chunkIndex", String(chunk.chunkIndex));
        fd.append("durationSeconds", String(chunk.durationSeconds));
        fd.append("contentType", chunk.contentType);
        fd.append("file", chunk.blob, `chunk-${chunk.chunkIndex}.webm`);
        navigator.sendBeacon?.("/api/audio/upload-chunk", fd);
      } catch {
        /* sendBeacon throws on payload-too-large (≥64KB on some
         * browsers, ≥1MB on others) — IndexedDB has the chunk, so
         * the next-session recovery still saves us. */
      }
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
      // Nudge Soniox so the WS doesn't 408 on the next inbound silence
      // window — sending an empty binary frame is a no-op but bumps
      // lastAudioSendAt indirectly via the WS being known-alive.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(new ArrayBuffer(0));
        } catch { /* ignore */ }
      }
      // The local-translator setTimeout was throttled while hidden, so any
      // in-flight utterance whose source advanced during the gap never got
      // re-translated. Re-arm the scheduler now that we're foreground.
      for (const u of this.currentUtterances.values()) {
        if (u.sourceFinal || u.sourcePending) {
          this.scheduleLiveTranslate(u);
        }
      }
    } catch (err) {
      console.warn("[recorder] visibility resume failed", err);
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

  /**
   * Periodically push a tiny chunk of silent PCM if the user has been quiet
   * for a few seconds. Without this, Soniox closes the WebSocket with code
   * 408 ("Request timeout") after a stretch of silence and the session
   * appears to fail despite the user only pausing to think.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const sampleRate = this.config.sampleRate ?? DEFAULT_SAMPLE_RATE;
    // 200 ms of zeroed Int16 mono samples.
    const silentBytes = Math.floor((sampleRate * 200) / 1000) * 2;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.wsOpen) return;
      // KEEP sending silent PCM while paused — otherwise Soniox times out
      // after ~5s with no audio and the close handler kicks in a reconnect
      // that silently un-pauses us. The PCM is zero-filled so no transcription
      // happens; we're just keeping the socket warm.
      const idleMs = performance.now() - this.lastAudioSendAt;
      if (idleMs < 3500) return;
      try {
        this.ws.send(new ArrayBuffer(silentBytes));
        this.lastAudioSendAt = performance.now();
      } catch {
        // Close handler will surface and trigger reconnect.
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
      // of a two-way translation pair. Match lecsync's strict mode: rejects
      // utterances in unhinted languages, keeping transcription focused on
      // the source ↔ target pair. Trade-off: heavy code-switching speakers
      // (Mandarin/English/Cantonese mixed within one sentence) may see some
      // tokens dropped. Users can override via NEXT_PUBLIC_SONIOX_LANGUAGE_HINTS_STRICT=0.
      language_hints: [this.config.sourceLanguage],
      language_hints_strict:
        process.env.NEXT_PUBLIC_SONIOX_LANGUAGE_HINTS_STRICT !== "0",
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
        this.lastAudioSendAt = performance.now();
        // Flush anything that was queued during connection.
        for (const buf of this.pcmQueue) {
          try { ws.send(buf); } catch { /* ignore */ }
        }
        this.pcmQueue = [];
        this.startHeartbeat();
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
      this.stopHeartbeat();
      // Auto-reconnect if the close wasn't initiated by us and we're still
      // mid-session. Don't fire during normal stop()/destroy() or while
      // device-recovery is the failure path.
      if (
        !this.intentionalShutdown &&
        this.state !== "stopping" &&
        this.state !== "ended" &&
        this.state !== "idle" &&
        this.state !== "error" &&
        // Defense-in-depth: even if a WS close slips past the heartbeat
        // (e.g. network blip during pause), don't auto-resume — the user's
        // pause intent has priority. Only reconnect on visible drops.
        this.state !== "paused"
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
    // recording to dump every Soniox frame token-by-token. Designed so each
    // line is a flat object you can read without expanding anything.
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
      // Same for utterances waiting on lagging translation: take what
      // we have and finalize. Their transFinal may still be empty,
      // which is fine — better than discarding the source line.
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

    // Per-speaker pending replacements for this frame. Soniox sends the
    // current in-flight guess as a snapshot, not as a delta, so we collect
    // everything non-final from this frame and assign at the end.
    const framePending = new Map<
      number | undefined,
      { source: string; trans: string }
    >();
    const finalizedThisFrame: UtteranceBuilder[] = [];
    const touched = new Set<number | undefined>();
    // Awaiting-trans bookkeeping for this frame: speakers whose queue head
    // received translation tokens (we emit a single update at frame end
    // rather than per-token), and whether any awaited utterance finalized
    // (so we know to schedule the segment POST flush).
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

      // ---- Translation token routing (high priority) ----
      // A translation token belongs to whichever awaiting utterance shares
      // its audio time span — Soniox tags translation tokens with the
      // start_ms / end_ms of the source token they translate, so we can
      // match by time even when multiple utterances are mid-await or when
      // the next sentence's source has already opened a new entry in
      // currentUtterances. Without this priority, translation tokens that
      // arrived AFTER the next source sentence started were misattributed
      // to that next sentence — visible as every card showing the
      // PREVIOUS sentence's translation ("+1 offset").
      if (isTranslation) {
        const queue = this.awaitingTrans.get(speakerId);
        if (queue && queue.length > 0) {
          // Find the awaiting utterance whose [startMs, endMs] window best
          // contains this token's startMs. 1500ms slop because Soniox
          // rounds boundaries and translation tokens may be slightly
          // outside the source span.
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
          // Fallback: no time match (Soniox occasionally omits start_ms
          // on translation tokens). Use FIFO queue head — at least we
          // route to AN awaited utterance instead of leaking into the
          // next sentence's currentUtterances entry.
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
          // Ignore non-final translation tokens during await.
          continue;
        }
        // No awaiting queue for this speaker — translation token has no
        // park to go to. Falls through to currentUtterances handling
        // below (could happen if Soniox sends a translation BEFORE the
        // matching source <end>; rare).
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

      // <end> marks utterance boundary — never render it as text.
      if (tok.text === "<end>") {
        if (isFinal) {
          // Preserve any live-translated text we wrote into transPending so
          // the finalized card / segment POST keeps it (otherwise translate
          // would run again post-finalize and waste a Chrome API call).
          if (u.transPending && !u.transFinal) {
            u.transFinal = u.transPending;
            u.transPending = "";
          }
          // Cloud mode: if Soniox hasn't delivered any translation for
          // this utterance yet, defer finalize and park in awaitingTrans
          // so the NEXT frame's translation tokens land on this utterance
          // (the queue head) rather than the next sentence's utterance.
          // See the awaitingTrans field comment for why.
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
            this.lastEnqueuedSourceBySpeaker.delete(speakerId);
            // Emit once now (with whatever transFinal we have, likely
            // empty) so the UI promotes the source card immediately;
            // we re-emit when the translation lands.
            this.emitUtterance(u, true);
          } else {
            finalizedThisFrame.push(u);
            this.currentUtterances.delete(speakerId);
            this.lastEnqueuedSourceBySpeaker.delete(speakerId);
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

    // Apply this frame's pending snapshot to each still-active utterance.
    let didSplit = false;
    const isLocalMode = this.config.translationMode === "local";
    for (const speakerId of touched) {
      const u = this.currentUtterances.get(speakerId);
      if (!u) continue; // finalized this frame
      const fp = framePending.get(speakerId);
      const rawSourcePending = fp?.source ?? "";
      const normalizedSourcePending = stripConsumedPendingPrefix(
        rawSourcePending,
        u.consumedSourcePending
      );
      if (!normalizedSourcePending.matched) u.consumedSourcePending = "";
      u.sourcePending = normalizedSourcePending.text;
      // In "cloud" mode Soniox emits a fresh translation snapshot every frame
      // and we mirror it. In "local" mode, Soniox never sends translations —
      // `scheduleLiveTranslate` is the sole writer of `transPending`, so
      // don't clobber the translation it just wrote.
      if (!isLocalMode) {
        const rawTransPending = fp?.trans ?? "";
        const normalizedTransPending = stripConsumedPendingPrefix(
          rawTransPending,
          u.consumedTransPending
        );
        if (!normalizedTransPending.matched) u.consumedTransPending = "";
        u.transPending = normalizedTransPending.text;
      }
      // Before emitting the in-flight state, see if any complete sentences
      // accumulated in finals — if so, spin them off as their own cards so
      // the live block stays short (Soniox doesn't always emit <end> for
      // every sentence boundary on its own).
      if (this.splitOffCompletedSentences(u)) didSplit = true;
      this.emitUtterance(u, false);
      this.scheduleLiveTranslate(u);
    }

    // Emit + queue POST for utterances that hit <end> this frame.
    for (const u of finalizedThisFrame) {
      this.emitUtterance(u, true);
      this.finalizeQueue.push(u);
    }

    // Re-emit awaiting heads whose translation grew this frame so the UI
    // updates from "source only" to "source + translation". Single emit
    // per speaker even if multiple translation tokens landed.
    for (const speakerId of awaitingTouched) {
      const queue = this.awaitingTrans.get(speakerId);
      if (queue && queue.length > 0) {
        this.emitUtterance(queue[0].u, true);
      }
    }

    // Grace-timeout sweep: force-finalize any awaiting head that has been
    // parked longer than AWAIT_TRANS_GRACE_MS. Without this, a permanently
    // dropped translation token (network hiccup, Soniox glitch) would
    // leave the utterance stranded in awaitingTrans forever and the
    // segment would never get POSTed.
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

  /**
   * If a still-in-flight utterance has accumulated more than one complete
   * sentence in its finals, peel everything except the last sentence off
   * into its own finalized card. Pairs source ↔ translation only when both
   * sides have the same sentence count; otherwise leaves the utterance
   * intact so the alignment stays correct. Returns true when a split
   * happened.
   */
  private splitOffCompletedSentences(u: UtteranceBuilder): boolean {
    const sourceFinalLength = u.sourceFinal.length;
    const sourceText = u.sourceFinal + u.sourcePending;
    const srcSentences = splitSentenceSpans(sourceText);
    if (srcSentences.length < 2) return false;
    const transSentences = splitSentences(u.transFinal);
    // Only split when translation has caught up — otherwise we risk
    // emitting source-only cards while the translation lags one sentence behind.
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
    // The remaining "tail" sentence becomes the new in-flight utterance.
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

  /**
   * Local-mode only: while an utterance is still growing, kick off Chrome
   * Translator on the running source text on a short debounce so the LIVE
   * card shows translation that grows alongside the source. Without this
   * translation only appears AFTER <end>, which makes the live block feel
   * like it's missing the bottom half.
   */
  /**
   * Local-mode: enqueue the in-flight utterance's running source text
   * for translation. Replaces the previous setTimeout(350) debounce.
   *
   * The queue's low-priority slot is single-element — if another
   * partial arrives while a translation is in flight, the slot is
   * overwritten and only the latest source gets translated next.
   * Natural backpressure, no fixed timer.
   */
  private scheduleLiveTranslate(u: UtteranceBuilder): void {
    if (this.config.translationMode !== "local") return;
    if (!this.translationQueue) return;
    const source = (u.sourceFinal + u.sourcePending).trim();
    if (!source) return;
    // Skip dupes — Soniox occasionally re-emits the same partial; no
    // point burning a translator call to produce the same output.
    const last = this.lastEnqueuedSourceBySpeaker.get(u.speakerId);
    if (last === source) return;
    this.lastEnqueuedSourceBySpeaker.set(u.speakerId, source);
    this.translationQueue.enqueue({
      id: makeTranslationJobId(),
      segmentId: u.id,
      text: source,
      priority: "low",
      timestamp: Date.now(),
    });
  }

  /** Build the TranslationQueue once at start. Result handler matches
   *  the result back to the still-in-flight utterance via segmentId
   *  (== u.id, stable across partials). Stale results (utterance has
   *  already finalized or been replaced) are dropped. */
  private setupTranslationQueue(): void {
    if (this.config.translationMode !== "local") return;
    if (this.translationQueue) return;
    this.translationQueue = new TranslationQueue();
    this.translationQueue.setHandlers({
      onResult: (job, translated) => {
        // Locate the in-flight utterance that this translation was for.
        // We match by id rather than speakerId so a fast speaker switch
        // can't accidentally apply A's translation to B's partial.
        for (const u of this.currentUtterances.values()) {
          if (u.id !== job.segmentId) continue;
          u.transFinal = ""; // replace, don't append
          u.transPending = translated;
          this.emitUtterance(u, false);
          return;
        }
        // Utterance no longer in-flight (finalized / discarded) — drop.
      },
      // Errors silently swallowed for partials; the finalize path
      // (translateLocal) has its own visible error surface.
    });
    this.translationQueue.setTranslator({
      translate: async (text: string) => {
        const r = await this.translateAutoDirection(text);
        if (r == null) {
          throw new Error("translator-unavailable");
        }
        return r;
      },
    });
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
   * await — transcript propagation must not block the recording pipeline.
   *
   * Adds one retry after 200ms for transient failures (network blip,
   * temporary 5xx). Without retry, viewers reported "漏字 / 少句子" because
   * a single dropped push for a final utterance permanently disappeared
   * from the viewer's stream. Viewer-side segment polling
   * (/api/live-share/[token]/segments) is the second line of defence.
   *
   * Treats non-2xx responses as failures too (the old version only caught
   * fetch() throwing, so a 502 from nginx silently swallowed the payload).
   */
  private pushLiveShare(payload: object): void {
    const token = this.config.liveShareToken;
    if (!token) return;
    // Fast path: WS is open, send the payload directly. Server broadcasts
    // to all viewers connected on this token. The exact same JSON shape
    // we'd otherwise POST goes on the wire.
    if (
      this.liveShareWs &&
      this.liveShareWsState === "open" &&
      this.liveShareWs.readyState === WebSocket.OPEN
    ) {
      try {
        this.liveShareWs.send(JSON.stringify(payload));
        return;
      } catch {
        // send() can throw if the socket closed between the readyState
        // check and the send call. Fall through to POST below.
      }
    }
    const url = `/api/live-share/${encodeURIComponent(token)}/push`;
    const body = JSON.stringify(payload);
    const attempt = async (retriesLeft: number): Promise<void> => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
        if (res.ok) return;
        // 4xx is permanent (bad token, etc.) — don't retry.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`push rejected (${res.status})`);
        }
        if (retriesLeft > 0) {
          await new Promise((r) => setTimeout(r, 200));
          return attempt(retriesLeft - 1);
        }
        throw new Error(`push failed after retry (${res.status})`);
      } catch (err) {
        if (retriesLeft > 0) {
          await new Promise((r) => setTimeout(r, 200));
          return attempt(retriesLeft - 1);
        }
        this.emitError(err, "live_share_push_failed", true);
      }
    };
    void attempt(1);
  }

  /**
   * Open the host-side live-share WS. Best-effort: any failure (no server,
   * 404, network drop) leaves state="failed" and pushLiveShare() silently
   * uses HTTP POST instead. Reconnects with the same backoff schedule as
   * the Soniox WS so a transient blip doesn't fall through to POST for
   * the rest of the session. Stops trying on intentional shutdown.
   */
  private openLiveShareWs(): void {
    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      return;
    }
    const token = this.config.liveShareToken;
    if (!token) return;
    if (
      this.liveShareWsState === "connecting" ||
      this.liveShareWsState === "open"
    ) {
      return;
    }
    if (this.intentionalShutdown) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws/live/${encodeURIComponent(
      token
    )}?role=host`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // Constructor throwing is rare (malformed URL only) — treat as
      // permanent failure for this token; POST fallback kicks in.
      this.liveShareWsState = "failed";
      return;
    }
    this.liveShareWs = ws;
    this.liveShareWsState = "connecting";

    ws.onopen = () => {
      // Guard against a stale ws firing after token rotated.
      if (this.liveShareWs !== ws) return;
      this.liveShareWsState = "open";
      this.liveShareWsReconnectAttempts = 0;
    };

    // Server doesn't push anything back to host today, but bind a no-op
    // listener so the browser doesn't buffer messages forever if that
    // changes server-side.
    ws.onmessage = () => {
      /* host doesn't consume server messages */
    };

    const handleDisconnect = () => {
      if (this.liveShareWs !== ws) return;
      // If we were "open" before, the socket dropped mid-session — count
      // this as the first failure and try to come back. If we never
      // reached "open", openLiveShareWs's onerror path handles it.
      this.liveShareWs = null;
      this.liveShareWsState = "failed";
      if (this.intentionalShutdown) return;
      if (!this.config.liveShareToken) return;
      // Only reconnect while recording — paused is OK (still want push),
      // but ended/stopped should let the socket stay closed.
      if (
        this.state !== "recording" &&
        this.state !== "paused" &&
        this.state !== "connected"
      ) {
        return;
      }
      this.scheduleLiveShareWsReconnect();
    };

    ws.onerror = handleDisconnect;
    ws.onclose = handleDisconnect;
  }

  private scheduleLiveShareWsReconnect(): void {
    if (this.intentionalShutdown) return;
    if (this.liveShareWsReconnectTimer) return;
    const attempt = this.liveShareWsReconnectAttempts;
    if (attempt >= this.LIVE_SHARE_WS_RECONNECT_BACKOFFS_MS.length) {
      // Exhausted retries — leave state="failed". pushLiveShare() now
      // walks the POST path for the rest of the session, which is the
      // intended graceful-degradation behaviour.
      return;
    }
    const delay = this.LIVE_SHARE_WS_RECONNECT_BACKOFFS_MS[attempt];
    this.liveShareWsReconnectAttempts = attempt + 1;
    this.liveShareWsReconnectTimer = setTimeout(() => {
      this.liveShareWsReconnectTimer = null;
      this.openLiveShareWs();
    }, delay);
  }

  /** Synchronous teardown of the live-share WS. Called from setLiveShareToken
   *  (token cleared / rotated), shutdownInternal, and destroy. */
  private closeLiveShareWs(): void {
    if (this.liveShareWsReconnectTimer) {
      clearTimeout(this.liveShareWsReconnectTimer);
      this.liveShareWsReconnectTimer = null;
    }
    this.liveShareWsReconnectAttempts = 0;
    if (this.liveShareWs) {
      // Detach handlers before close so the close handler's reconnect
      // path doesn't fire on an intentional teardown.
      try {
        this.liveShareWs.onopen = null;
        this.liveShareWs.onmessage = null;
        this.liveShareWs.onerror = null;
        this.liveShareWs.onclose = null;
      } catch {
        /* ignore */
      }
      try {
        this.liveShareWs.close();
      } catch {
        /* ignore */
      }
      this.liveShareWs = null;
    }
    this.liveShareWsState = "closed";
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
      // Server route may return SegmentDTO[], {segments:[]}, or {items:[]}.
      // The current route hands back {items:[]} (PaginatedResponse shape),
      // so without this fallback the for-loop below sees an empty array and
      // translateLocal never runs — that's why translated text never showed.
      const segs = Array.isArray(body)
        ? body
        : body.segments ?? body.items ?? [];
      for (const seg of segs) {
        const utteranceId = indexToUtteranceId.get(seg.segmentIndex);
        if (utteranceId) this.segmentToUtterance.set(seg.id, utteranceId);
        this.onEvent({ segment: seg });
        this.pushLiveShare({ type: "segment", segment: seg, utteranceId });
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
          this.lastAudioSendAt = performance.now();
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
      const idx = this.chunkIndex++;
      const prevAt = this.lastChunkAtMs;
      const nowMs = performance.now();
      this.lastChunkAtMs = nowMs;
      const elapsedSec =
        prevAt === null
          ? (this.config.uploadIntervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS) / 1000
          : Math.max(0, (nowMs - prevAt) / 1000);
      const durationMs = Math.round(elapsedSec * 1000);
      const contentType = blob.type || this.mediaMime;
      // ---- Durability: persist to IndexedDB BEFORE the network ----
      // If the tab closes / browser crashes between this fire and the
      // PUT/POST completing, the chunk is still on disk locally and
      // boot-time recovery (next session load) will retry the upload.
      // sendBeacon (pagehide handler below) is the secondary safety
      // net for in-memory chunks that haven't been written here yet.
      void getAudioLocalCache()
        .storeChunk(
          this.config.sessionId,
          idx,
          blob,
          durationMs,
          contentType
        )
        .catch(() => {
          // Disk pressure / private-browsing IndexedDB denial — best
          // effort, fall through to the network-only path.
        });
      // Track the most recent in-flight chunk so the pagehide handler
      // can sendBeacon it if the tab is closing.
      this.lastInFlightChunk = {
        chunkIndex: idx,
        blob,
        durationSeconds: elapsedSec,
        contentType,
      };
      // Each blob is one chunk; queue serially so we keep ordering.
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

    // 4. Flip the IndexedDB row to uploaded so boot-time recovery skips
    //    it. Best-effort — if IndexedDB is unavailable we just retry
    //    next session, which the server will dedupe by chunkIndex.
    void getAudioLocalCache()
      .markUploaded(this.config.sessionId, chunkIndex)
      .catch(() => {});

    // 5. Drop the in-memory reference for sendBeacon — the chunk is
    //    durably on the server. If a newer chunk has been buffered in
    //    the meantime we leave that one alone.
    if (this.lastInFlightChunk?.chunkIndex === chunkIndex) {
      this.lastInFlightChunk = null;
    }
  }

  /**
   * Drain any IndexedDB rows still marked uploaded=false for this
   * session by re-POSTing them through the single-shot multipart
   * endpoint (same path sendBeacon + boot-time recovery use — server
   * upserts on (sessionId, chunkIndex) so retrying a chunk that
   * partially succeeded is harmless).
   *
   * Returns true iff IDB is empty (or only contains already-uploaded
   * rows) after the drain. The caller uses that as a precondition for
   * /api/audio/finalize — finalizing while chunks are still pending
   * is what produced shorter-than-transcript audio in the past.
   */
  private async flushPendingChunksFromCache(
    sessionId: string
  ): Promise<boolean> {
    const cache = getAudioLocalCache();
    let pending;
    try {
      pending = await cache.getPendingChunks(sessionId);
    } catch {
      // IDB inaccessible — best-effort assume nothing to flush. Server
      // will finalize with whatever chunk-record rows it has.
      return true;
    }
    if (pending.length === 0) return true;
    for (const row of pending) {
      try {
        const fd = new FormData();
        fd.append("sessionId", row.sessionId);
        fd.append("chunkIndex", String(row.chunkIndex));
        fd.append("durationSeconds", String((row.durationMs ?? 0) / 1000));
        fd.append("contentType", row.contentType);
        fd.append("file", row.blob, `chunk-${row.chunkIndex}.webm`);
        const resp = await fetch("/api/audio/upload-chunk", {
          method: "POST",
          body: fd,
        });
        if (resp.ok) {
          await cache.markUploaded(sessionId, row.chunkIndex).catch(() => {});
        }
      } catch {
        // Network blip — leave this row pending; the next iteration
        // (or next session's boot recovery) will retry.
      }
    }
    // Re-check — if any still pending, the upload failed for real and
    // we can't finalize safely.
    try {
      const stillPending = await cache.getPendingChunks(sessionId);
      return stillPending.length === 0;
    } catch {
      return true;
    }
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
      const translatedText = await this.translateAutoDirection(seg.sourceText);
      if (translatedText == null) {
        // Chrome doesn't have this language pair. Try the cloud (/api/translate)
        // once silently — but if that ALSO fails (Gemini quota exhausted, key
        // invalid, etc.), keep quiet. Surfacing a 500 toast per segment is
        // useless spam; user needs to either switch to "云端翻译" mode (Soniox
        // WS two-way, no Gemini) or fix their Gemini key/quota.
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

  /**
   * Cached Chrome Translator for an arbitrary (src → tgt) pair. The first
   * call for a pair warms the on-device model (~200-500ms); subsequent
   * lookups are instant.
   */
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
    // Check availability before create(). Calling create() on a "downloadable"
    // pair throws "user gesture required" — and the recorder doesn't run
    // inside a user gesture (the click was consumed by the session-POST
    // awaiting before we got here). Returning null here lets the caller fall
    // back to cloud translation silently.
    const p: Promise<{ translate(text: string): Promise<string> } | null> = (async () => {
      try {
        const a = await T.availability({ sourceLanguage: src, targetLanguage: tgt });
        if (a !== "available" && a !== "downloading") {
          // "downloadable" or "unavailable" — we can't create from here.
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

  /**
   * Pick the right direction for a piece of source text and translate it.
   * In two-way mode the speaker might switch between the configured source
   * and target language sentence-by-sentence — we detect which side this
   * utterance is on and translate to the other.
   */
  private async translateAutoDirection(text: string): Promise<string | null> {
    if (!text) return null;
    const src = this.config.sourceLanguage;
    const tgt = this.config.targetLanguage;
    const srcIsCJK = /^(zh|ja|ko)/i.test(src);
    const tgtIsCJK = /^(zh|ja|ko)/i.test(tgt);
    let from: string;
    let to: string;
    if (srcIsCJK === tgtIsCJK) {
      // Both sides CJK (e.g. JA↔ZH) or neither CJK (e.g. EN↔ES). The
      // character-class heuristic can't distinguish them, so trust the
      // configured direction.
      from = src;
      to = tgt;
    } else {
      // Exactly one side is CJK — detect which side the speech is on.
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
      this.onEvent({ segment: updated });
      const utteranceId = this.segmentToUtterance.get(updated.id);
      this.pushLiveShare({ type: "segment", segment: updated, utteranceId });
      // Bridge the translation back to the live utterance card the UI is
      // rendering. Without this the Card never re-renders with translated
      // text because the UI listens for `utterance` events, not segment ones.
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
    this.intentionalShutdown = true;
    this.closeLiveShareWs();
    this.detachDeviceMonitor();
    this.detachVisibilityMonitor();
    this.detachPageHideMonitor();
    this.stopHeartbeat();
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    if (this.translationQueue) {
      this.translationQueue.destroy();
      this.translationQueue = null;
    }
    this.lastEnqueuedSourceBySpeaker.clear();
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
