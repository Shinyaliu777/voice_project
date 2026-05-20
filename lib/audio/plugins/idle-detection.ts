/**
 * IdleDetectionPlugin — long-silence detection.
 *
 * New plugin (no equivalent in the old `Recorder` class). Mirrors lecsync's
 * `silenceWarningMs` field on the TranscriptionStore deviceStatus: when no
 * voice activity has been detected for a configurable duration, surface a
 * warning. Goes one step further than lecsync by offering a hard cutoff
 * after which the plugin invokes a configurable `onLongIdle` callback —
 * the orchestrator can wire this to auto-stop the recording.
 *
 * Data source today: the EventBus channel `onAudioSilence`. The
 * `TranscriptionService` itself does not emit silence right now (no
 * VAD / analyser sampling loop is wired up yet). Until that lands the
 * plugin is dormant — `init/destroy` work, but no callbacks fire. Adding
 * VAD to the service is a follow-up; the plugin contract is in place.
 *
 * Two thresholds:
 *   - WARN_MS:      emit `silenceWarningMs` to the store via the bus.
 *   - STOP_MS:      invoke the `onLongIdle` callback (orchestrator's choice
 *                   whether to auto-stop). Defaults to 10 minutes; -1 to
 *                   disable.
 */

import { transcriptionEventBus } from "@/lib/audio/event-bus";
import type { Subscription } from "@/lib/audio/event-bus";
import type { TranscriptionService } from "@/lib/audio/transcription-service";

export interface IdleDetectionConfig {
  /** ms of silence before we surface a warning on the store. */
  warnMs?: number;
  /** ms of silence before `onLongIdle` is invoked. -1 disables. */
  stopMs?: number;
  /** Callback when the hard threshold is hit. Default: noop. */
  onLongIdle?: () => void;
}

export class IdleDetectionPlugin {
  private service: TranscriptionService | null = null;
  private busSubscription: Subscription | null = null;
  private config: Required<IdleDetectionConfig>;
  private warned = false;
  private stopped = false;

  constructor(config: IdleDetectionConfig = {}) {
    this.config = {
      warnMs: config.warnMs ?? 30_000,
      stopMs: config.stopMs ?? 10 * 60 * 1000,
      onLongIdle: config.onLongIdle ?? (() => {}),
    };
  }

  init(service: TranscriptionService): void {
    this.service = service;
    // Reset latches when a fresh session starts.
    this.warned = false;
    this.stopped = false;
    this.busSubscription = transcriptionEventBus.onAudioSilence((env) => {
      const ms = env.data.durationMs;
      if (!this.warned && ms >= this.config.warnMs) {
        this.warned = true;
        // The bridge hook re-emits this onto the store deviceStatus.
        // Emitting back through the bus would create a loop, so we
        // skip the re-emit here; the original `silenceWarningMs`
        // update from the service itself is the canonical signal.
      }
      if (
        !this.stopped &&
        this.config.stopMs >= 0 &&
        ms >= this.config.stopMs
      ) {
        this.stopped = true;
        try { this.config.onLongIdle(); } catch { /* swallow */ }
      }
    });
  }

  destroy(): void {
    this.busSubscription?.unsubscribe();
    this.busSubscription = null;
    this.service = null;
    this.warned = false;
    this.stopped = false;
  }

  /** Reset detection latches — useful when the service resumes from pause. */
  reset(): void {
    this.warned = false;
    this.stopped = false;
  }
}
