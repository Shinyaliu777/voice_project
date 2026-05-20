/**
 * TranscriptionApp — orchestrator that composes TranscriptionService + plugins.
 *
 * Mirrors lecsync's `TranscriptionApp` class (see
 * `~/.claude/projects/.../memory/voice_project_lecsync_architecture.md`
 * "TranscriptionApp 类（核心引擎）" section). The orchestrator itself
 * does no recording — it owns the service and the plugins, exposes a
 * small public API (`startRecording / stopRecording / destroy /
 * isRecording`), and forwards configuration changes through to the
 * pieces that care.
 *
 *   TranscriptionApp
 *     ├─ TranscriptionService  (Soniox WS + worklet + MediaRecorder + WS reconnect)
 *     ├─ PersistencePlugin     (IndexedDB chunk cache + sendBeacon + upload pipeline)
 *     ├─ MinutesPlugin         (/api/minutes/stream SSE)
 *     ├─ LiveSharePlugin       (host-side share token push)
 *     ├─ IdleDetectionPlugin   (long-silence detection — auto stop)
 *     ├─ RecordingControlPlugin(/api/recording/{start,queue-status,release})
 *     └─ PipPlugin             (Document Picture-in-Picture floating subtitle)
 *
 * The orchestrator lives behind `useTranscriptionApp()` (via the
 * Context provider in `transcription-app-provider.tsx`) so any page
 * inside the dashboard tree can call `start/stop` without holding a
 * reference to the React subtree that mounted the engine.
 */

import type { RecorderConfig, RecorderState } from "@/lib/contracts";
import { TranscriptionService } from "@/lib/audio/transcription-service";
import { IdleDetectionPlugin } from "@/lib/audio/plugins/idle-detection";
import { LiveSharePlugin } from "@/lib/audio/plugins/live-share";
import { MinutesPlugin } from "@/lib/audio/plugins/minutes";
import { PersistencePlugin } from "@/lib/audio/plugins/persistence";
import { PipPlugin } from "@/lib/audio/plugins/pip";
import { RecordingControlPlugin } from "@/lib/audio/plugins/recording-control";

export interface BrowserSupport {
  microphone: boolean;
  audioWorklet: boolean;
  webSocket: boolean;
  documentPictureInPicture: boolean;
  chromeAiTranslation: boolean;
}

export interface StartRecordingOptions {
  /**
   * Live-share token to mirror utterances to. Pass nothing or `null` to
   * record without sharing. Can also be set later via getLiveSharePlugin().setToken().
   */
  liveShareToken?: string | null;
  /** Language code for the minutes plugin's incremental stream. */
  minutesLanguage?: string;
}

export class TranscriptionApp {
  private service: TranscriptionService | null = null;
  private readonly persistencePlugin: PersistencePlugin;
  private readonly minutesPlugin: MinutesPlugin;
  private readonly liveSharePlugin: LiveSharePlugin;
  private readonly idleDetectionPlugin: IdleDetectionPlugin;
  private readonly recordingControlPlugin: RecordingControlPlugin;
  private readonly pipPlugin: PipPlugin;

  /** Plugins are constructed at orchestrator construction so getters work
   *  even before the first startRecording() call (the UI sometimes wires
   *  the PiP toggle before recording begins). */
  constructor() {
    this.persistencePlugin = new PersistencePlugin();
    this.minutesPlugin = new MinutesPlugin();
    this.liveSharePlugin = new LiveSharePlugin();
    this.idleDetectionPlugin = new IdleDetectionPlugin({
      onLongIdle: () => {
        // Auto-stop on prolonged silence. Best-effort — if stopRecording
        // is already in flight the second call is a no-op.
        void this.stopRecording().catch(() => {});
      },
    });
    this.recordingControlPlugin = new RecordingControlPlugin();
    this.pipPlugin = new PipPlugin();
  }

  // ---- public API ----

  async startRecording(
    config: RecorderConfig,
    options: StartRecordingOptions = {}
  ): Promise<void> {
    if (this.service && this.service.getState() !== "idle" && this.service.getState() !== "ended") {
      throw new Error(
        `TranscriptionApp.startRecording() called while service state=${this.service.getState()}`
      );
    }

    // 1) Queue check (stub today — Agent D will implement).
    const queue = await this.recordingControlPlugin.requestStart(config.sessionId);
    if (queue.status === "denied") {
      throw new Error(queue.reason);
    }

    // 2) Spin up a fresh service per session — the lifecycle is one-shot.
    const service = new TranscriptionService(config);
    this.service = service;

    // 3) Wire plugins to the new service. Each plugin uses
    //    `service.setListeners(...)`, which merges rather than replaces,
    //    so attaching multiple is safe.
    this.persistencePlugin.init(service);
    this.minutesPlugin.init(service);
    this.liveSharePlugin.init(service);
    this.idleDetectionPlugin.init(service);
    this.recordingControlPlugin.init(service);
    this.pipPlugin.init(service);

    // 4) Forward the start-time live-share token (if any) through the plugin
    //    so its mirror channel activates from the first utterance.
    if (typeof options.liveShareToken === "string") {
      this.liveSharePlugin.setToken(options.liveShareToken);
    } else if (config.liveShareToken) {
      this.liveSharePlugin.setToken(config.liveShareToken);
    }

    // 5) Tell the minutes plugin which session to address.
    this.minutesPlugin.attachSession(config.sessionId, {
      language: options.minutesLanguage ?? config.targetLanguage,
      startedAtMs: Date.now(),
    });

    // 6) Kick off the engine.
    try {
      await service.start();
    } catch (err) {
      // Teardown plugins on failed start so the next attempt is clean.
      await this.tearDownPlugins();
      this.service = null;
      throw err;
    }
  }

  async stopRecording(): Promise<void> {
    const service = this.service;
    if (!service) return;
    const sessionId = service.getConfig().sessionId;
    try {
      await service.stop();
    } finally {
      // Persistence flushes any in-flight chunk uploads so the next session
      // doesn't double-upload them.
      await this.persistencePlugin.flushPendingUploads();
      // Drop IndexedDB rows now that finalize is in (best-effort — if the
      // server-side finalize POSTed earlier failed, we keep the rows by
      // skipping this; the service surfaces a `finalize_failed` error on
      // the bus and the next-boot recovery handles it).
      await this.persistencePlugin.onSessionFinalized(sessionId).catch(() => {});
      await this.recordingControlPlugin.release(sessionId).catch(() => {});
      this.minutesPlugin.detachSession();
      await this.tearDownPlugins();
      this.service = null;
    }
  }

  /** Hard teardown. Stops everything synchronously / best-effort. */
  async destroy(): Promise<void> {
    try {
      await this.stopRecording().catch(() => {});
    } finally {
      // Plugins still own resources even when no service is attached
      // (e.g. a PiP window the user opened independently). Make sure
      // we tear those down too.
      this.persistencePlugin.destroy();
      this.minutesPlugin.destroy();
      this.liveSharePlugin.destroy();
      this.idleDetectionPlugin.destroy();
      this.recordingControlPlugin.destroy();
      this.pipPlugin.destroy();
    }
  }

  isRecording(): boolean {
    return this.service?.getState() === "recording";
  }

  getState(): RecorderState {
    return this.service?.getState() ?? "idle";
  }

  getMediaStream(): MediaStream | null {
    return this.service?.getMediaStream() ?? null;
  }

  // ---- plugin getters ----

  getPersistencePlugin(): PersistencePlugin {
    return this.persistencePlugin;
  }

  getMinutesPlugin(): MinutesPlugin {
    return this.minutesPlugin;
  }

  getLiveSharePlugin(): LiveSharePlugin {
    return this.liveSharePlugin;
  }

  getIdleDetectionPlugin(): IdleDetectionPlugin {
    return this.idleDetectionPlugin;
  }

  getRecordingControlPlugin(): RecordingControlPlugin {
    return this.recordingControlPlugin;
  }

  getPipPlugin(): PipPlugin {
    return this.pipPlugin;
  }

  // ---- static helpers ----

  /** Capability probe — call before showing the "Start recording" button. */
  static checkBrowserSupport(): BrowserSupport {
    const hasWindow = typeof window !== "undefined";
    const hasNavigator = typeof navigator !== "undefined";
    const microphone =
      hasNavigator &&
      typeof navigator.mediaDevices?.getUserMedia === "function";
    const audioWorklet =
      hasWindow &&
      typeof window.AudioContext !== "undefined" &&
      typeof (window.AudioContext.prototype as AudioContext).audioWorklet !==
        "undefined";
    const webSocket = hasWindow && typeof window.WebSocket !== "undefined";
    const documentPictureInPicture =
      hasWindow &&
      typeof (window as unknown as { documentPictureInPicture?: unknown })
        .documentPictureInPicture !== "undefined";
    const chromeAiTranslation =
      hasWindow &&
      typeof (window as unknown as { Translator?: unknown }).Translator !==
        "undefined";
    return {
      microphone,
      audioWorklet,
      webSocket,
      documentPictureInPicture,
      chromeAiTranslation,
    };
  }

  // ---- internals ----

  private async tearDownPlugins(): Promise<void> {
    // Reverse order of init so teardown unwinds cleanly.
    try { this.pipPlugin.destroy(); } catch { /* swallow */ }
    try { this.recordingControlPlugin.destroy(); } catch { /* swallow */ }
    try { this.idleDetectionPlugin.destroy(); } catch { /* swallow */ }
    try { this.liveSharePlugin.destroy(); } catch { /* swallow */ }
    try { this.minutesPlugin.destroy(); } catch { /* swallow */ }
    try { this.persistencePlugin.destroy(); } catch { /* swallow */ }
  }
}
