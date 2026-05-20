/**
 * TranscriptionEventBus — singleton pub/sub for the recording engine.
 *
 * Architecture pattern (decompiled from lecsync's 3e78f0446cc53587.js):
 *
 *   imperative recording engine (Soniox WS / worklet / MediaRecorder)
 *       │
 *       │  bus.emitFinalTranscript({...})
 *       ▼
 *   TranscriptionEventBus  ◄────── singleton, getInstance()
 *       │
 *       │  bus.onFinalTranscript(cb)  (subscribed from a React hook)
 *       ▼
 *   useTranscriptionEventSync()  →  dispatches Zustand store actions
 *       │
 *       ▼
 *   useTranscriptionStore(selector)  →  React renders
 *
 * This is the wedge between the imperative recording engine and the
 * declarative React tree. The engine doesn't know React exists; React
 * doesn't know the engine exists. Adding a new engine event = add a
 * new method here and a new store action; the engine is untouched.
 *
 * Compare to the current Recorder's `onEvent` callback wiring — single
 * fat callback that ties the engine to one consumer. This bus lets
 * many consumers (store + analytics + dev tools + live-share) listen
 * independently.
 */

// ---------- minimal EventEmitter ----------

interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  data: T;
  timestamp: number;
}

export interface Subscription {
  unsubscribe(): void;
}

class EventEmitter {
  private listeners = new Map<string, Set<(env: EventEnvelope) => void>>();
  private eventIdCounter = 0;

  on(event: string, cb: (env: EventEnvelope) => void): Subscription {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return {
      unsubscribe: () => {
        set!.delete(cb);
        if (set!.size === 0) this.listeners.delete(event);
      },
    };
  }

  once(event: string, cb: (env: EventEnvelope) => void): Subscription {
    const sub = this.on(event, (env) => {
      sub.unsubscribe();
      cb(env);
    });
    return sub;
  }

  async emit(event: string, data: unknown): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    const env: EventEnvelope = {
      id: this.generateId(),
      type: event,
      data,
      timestamp: Date.now(),
    };
    const started = performance.now();
    // Promise.allSettled so one slow/throwing listener doesn't block the
    // rest. Matches lecsync's behavior.
    await Promise.allSettled(
      Array.from(set).map((cb) => Promise.resolve(cb(env)))
    );
    const elapsed = performance.now() - started;
    if (elapsed > 100) {
      console.warn(
        `[EventBus] "${event}" dispatch took ${elapsed.toFixed(1)}ms (target: <100ms)`
      );
    }
  }

  off(event: string): void {
    this.listeners.delete(event);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  private generateId(): string {
    return `evt_${Date.now()}_${++this.eventIdCounter}`;
  }
}

// ---------- transcription event types ----------

export const TranscriptionEventType = {
  PARTIAL_TRANSCRIPT: "partial_transcript",
  FINAL_TRANSCRIPT: "final_transcript",
  PARTIAL_TRANSLATION: "partial_translation",
  FINAL_TRANSLATION: "final_translation",
  CONNECTION_STATUS: "connection_status",
  ERROR: "error",
  DEVICE_DISCONNECTED: "device_disconnected",
  DEVICE_RECOVERED: "device_recovered",
  DEVICE_RECOVERY_FAILED: "device_recovery_failed",
  AUDIO_SILENCE: "audio_silence",
  AUDIO_CONTEXT_STATE_CHANGE: "audio_context_state_change",
} as const;

export type TranscriptionEventName =
  (typeof TranscriptionEventType)[keyof typeof TranscriptionEventType];

// Payload shapes — kept minimal but typed.
// `timestamp` is added by emit() automatically; payload only carries the
// per-event fields.

export interface PartialTranscriptPayload {
  text: string;
  speaker?: number;
}

export interface FinalTranscriptPayload {
  segmentId: string;
  text: string;
  confidence?: number;
  speaker?: number;
  startMs?: number;
  endMs?: number;
}

export interface PartialTranslationPayload {
  text: string;
  speaker?: number;
}

export interface FinalTranslationPayload {
  segmentId: string;
  translatedText: string;
}

export interface ConnectionStatusPayload {
  status: "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
  sessionId?: string;
  latency?: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
  retriable: boolean;
}

export interface DeviceDisconnectedPayload {
  deviceLabel: string;
  reason: string;
}

export interface DeviceRecoveredPayload {
  deviceLabel: string;
  attempts: number;
}

export interface DeviceRecoveryFailedPayload {
  deviceLabel: string;
  attempts: number;
}

export interface AudioSilencePayload {
  durationMs: number;
  isDeviceFault: boolean;
}

export interface AudioContextStateChangePayload {
  state: AudioContextState;
}

// ---------- TranscriptionEventBus singleton ----------

export class TranscriptionEventBus extends EventEmitter {
  private static instance: TranscriptionEventBus | null = null;

  static getInstance(): TranscriptionEventBus {
    if (!TranscriptionEventBus.instance) {
      TranscriptionEventBus.instance = new TranscriptionEventBus();
    }
    return TranscriptionEventBus.instance;
  }

  static resetInstance(): void {
    if (TranscriptionEventBus.instance) {
      TranscriptionEventBus.instance.removeAllListeners();
      TranscriptionEventBus.instance = null;
    }
  }

  // ---- typed on/emit pairs ----

  onPartialTranscript(
    cb: (env: EventEnvelope<PartialTranscriptPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.PARTIAL_TRANSCRIPT,
      cb as (env: EventEnvelope) => void
    );
  }
  emitPartialTranscript(payload: PartialTranscriptPayload): Promise<void> {
    return this.emit(TranscriptionEventType.PARTIAL_TRANSCRIPT, payload);
  }

  onFinalTranscript(
    cb: (env: EventEnvelope<FinalTranscriptPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.FINAL_TRANSCRIPT,
      cb as (env: EventEnvelope) => void
    );
  }
  emitFinalTranscript(payload: FinalTranscriptPayload): Promise<void> {
    return this.emit(TranscriptionEventType.FINAL_TRANSCRIPT, payload);
  }

  onPartialTranslation(
    cb: (env: EventEnvelope<PartialTranslationPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.PARTIAL_TRANSLATION,
      cb as (env: EventEnvelope) => void
    );
  }
  emitPartialTranslation(payload: PartialTranslationPayload): Promise<void> {
    return this.emit(TranscriptionEventType.PARTIAL_TRANSLATION, payload);
  }

  onFinalTranslation(
    cb: (env: EventEnvelope<FinalTranslationPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.FINAL_TRANSLATION,
      cb as (env: EventEnvelope) => void
    );
  }
  emitFinalTranslation(payload: FinalTranslationPayload): Promise<void> {
    return this.emit(TranscriptionEventType.FINAL_TRANSLATION, payload);
  }

  onConnectionStatus(
    cb: (env: EventEnvelope<ConnectionStatusPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.CONNECTION_STATUS,
      cb as (env: EventEnvelope) => void
    );
  }
  emitConnectionStatus(payload: ConnectionStatusPayload): Promise<void> {
    return this.emit(TranscriptionEventType.CONNECTION_STATUS, payload);
  }

  onError(cb: (env: EventEnvelope<ErrorPayload>) => void): Subscription {
    return this.on(
      TranscriptionEventType.ERROR,
      cb as (env: EventEnvelope) => void
    );
  }
  emitError(payload: ErrorPayload): Promise<void> {
    return this.emit(TranscriptionEventType.ERROR, payload);
  }

  onDeviceDisconnected(
    cb: (env: EventEnvelope<DeviceDisconnectedPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.DEVICE_DISCONNECTED,
      cb as (env: EventEnvelope) => void
    );
  }
  emitDeviceDisconnected(payload: DeviceDisconnectedPayload): Promise<void> {
    return this.emit(TranscriptionEventType.DEVICE_DISCONNECTED, payload);
  }

  onDeviceRecovered(
    cb: (env: EventEnvelope<DeviceRecoveredPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.DEVICE_RECOVERED,
      cb as (env: EventEnvelope) => void
    );
  }
  emitDeviceRecovered(payload: DeviceRecoveredPayload): Promise<void> {
    return this.emit(TranscriptionEventType.DEVICE_RECOVERED, payload);
  }

  onDeviceRecoveryFailed(
    cb: (env: EventEnvelope<DeviceRecoveryFailedPayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.DEVICE_RECOVERY_FAILED,
      cb as (env: EventEnvelope) => void
    );
  }
  emitDeviceRecoveryFailed(payload: DeviceRecoveryFailedPayload): Promise<void> {
    return this.emit(TranscriptionEventType.DEVICE_RECOVERY_FAILED, payload);
  }

  onAudioSilence(
    cb: (env: EventEnvelope<AudioSilencePayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.AUDIO_SILENCE,
      cb as (env: EventEnvelope) => void
    );
  }
  emitAudioSilence(payload: AudioSilencePayload): Promise<void> {
    return this.emit(TranscriptionEventType.AUDIO_SILENCE, payload);
  }

  onAudioContextStateChange(
    cb: (env: EventEnvelope<AudioContextStateChangePayload>) => void
  ): Subscription {
    return this.on(
      TranscriptionEventType.AUDIO_CONTEXT_STATE_CHANGE,
      cb as (env: EventEnvelope) => void
    );
  }
  emitAudioContextStateChange(
    payload: AudioContextStateChangePayload
  ): Promise<void> {
    return this.emit(TranscriptionEventType.AUDIO_CONTEXT_STATE_CHANGE, payload);
  }
}

export type { EventEnvelope };

export const transcriptionEventBus = TranscriptionEventBus.getInstance();
