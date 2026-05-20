/**
 * TranscriptionStore — Zustand store for all renderable recording state.
 *
 * Schema mirrors lecsync's TranscriptionStore (decompiled from
 * 3e78f0446cc53587.js). Trimmed down to the fields voice_project
 * actually needs today; more can be added as features arrive.
 *
 * Subscribe pattern: `useTranscriptionStore(s => s.segments)` — Zustand
 * only re-renders when the selected slice changes (referential
 * equality). UI components ask for only what they need.
 *
 * Mutation pattern: actions live on the store itself. Engine code
 * never writes here directly — it emits to the EventBus, and
 * `useTranscriptionEventSync` dispatches the right action. That keeps
 * the engine ignorant of React.
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

// ---------- domain types ----------

export type RecordingState =
  | "idle"
  | "starting"
  | "queued"
  | "recording"
  | "pausing"
  | "paused"
  | "resuming"
  | "ending"
  | "ended";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface Segment {
  id: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence?: number;
  speaker?: number;
  startMs?: number;
  endMs?: number;
}

export interface Translation {
  segmentId: string;
  translatedText: string;
  originalText?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  timestamp?: number;
}

export interface ConnectionGap {
  id: string;
  startTime: number;
  endTime?: number;
}

export interface DeviceStatus {
  isConnected: boolean;
  isRecovering: boolean;
  deviceLabel: string;
  isFallback: boolean;
  recoveryFailed: boolean;
  silenceWarningMs: number | null;
  silenceIsDeviceFault: boolean;
}

export interface TranscriptionError {
  code: string;
  message: string;
  retriable: boolean;
}

// ---------- store shape ----------

interface TranscriptionState {
  // ---- connection / lifecycle ----
  connectionStatus: ConnectionStatus;
  sessionId: string | null;         // Soniox WS session id
  dbSessionId: string | null;       // DB Session.id (foreign key target)
  latency: number | null;
  recordingState: RecordingState;
  recordingStartTime: number | null;
  /** ms offset for resumed sessions — clock display continues from here */
  elapsedOffset: number;

  // ---- capture config ----
  sourceLanguage: string;

  // ---- live text ----
  partialTranscript: string;
  partialTranslation: string;
  segments: Segment[];
  translations: Translation[];

  // ---- diagnostics ----
  connectionGaps: ConnectionGap[];
  deviceStatus: DeviceStatus;
  lastError: TranscriptionError | null;
}

interface TranscriptionActions {
  setConnectionStatus(status: ConnectionStatus, sessionId?: string | null): void;
  setLatency(latency: number | null): void;
  setRecordingState(state: RecordingState): void;
  setDbSessionId(id: string | null): void;
  setSourceLanguage(lang: string): void;
  setElapsedOffset(ms: number): void;

  setPartialTranscript(text: string): void;
  setPartialTranslation(text: string): void;

  addSegment(s: Segment): void;
  updateSegment(id: string, patch: Partial<Segment>): void;
  clearTranscripts(): void;
  restoreSegments(segments: Segment[], translations: Translation[]): void;

  addTranslation(t: Translation): void;
  updateTranslation(segmentId: string, translatedText: string): void;

  setDeviceStatus(patch: Partial<DeviceStatus>): void;
  resetDeviceStatus(): void;

  addConnectionGap(gap: ConnectionGap): void;
  closeConnectionGap(id: string, endTime: number): void;
  clearConnectionGaps(): void;

  setError(err: TranscriptionError | null): void;

  reset(): void;
}

export type TranscriptionStore = TranscriptionState & TranscriptionActions;

// ---------- initial state ----------

const initialDeviceStatus: DeviceStatus = {
  isConnected: true,
  isRecovering: false,
  deviceLabel: "",
  isFallback: false,
  recoveryFailed: false,
  silenceWarningMs: null,
  silenceIsDeviceFault: false,
};

const initialState: TranscriptionState = {
  connectionStatus: "disconnected",
  sessionId: null,
  dbSessionId: null,
  latency: null,
  recordingState: "idle",
  recordingStartTime: null,
  elapsedOffset: 0,
  sourceLanguage: "en",
  partialTranscript: "",
  partialTranslation: "",
  segments: [],
  translations: [],
  connectionGaps: [],
  deviceStatus: initialDeviceStatus,
  lastError: null,
};

// ---------- store factory ----------

export const useTranscriptionStore = create<TranscriptionStore>()(
  devtools(
    (set) => ({
      ...initialState,

      setConnectionStatus: (status, sessionId) =>
        set(
          (s) => ({
            connectionStatus: status,
            sessionId: sessionId ?? s.sessionId,
            lastError: status === "error" ? s.lastError : null,
            latency: status === "disconnected" ? null : s.latency,
          }),
          false,
          "setConnectionStatus"
        ),

      setLatency: (latency) => set({ latency }, false, "setLatency"),

      setRecordingState: (rs) =>
        set(
          (s) => ({
            recordingState: rs,
            recordingStartTime:
              rs === "recording" && s.recordingState !== "recording"
                ? Date.now()
                : rs === "idle" || rs === "ended"
                  ? null
                  : s.recordingStartTime,
          }),
          false,
          "setRecordingState"
        ),

      setDbSessionId: (id) => set({ dbSessionId: id }, false, "setDbSessionId"),
      setSourceLanguage: (lang) =>
        set({ sourceLanguage: lang }, false, "setSourceLanguage"),
      setElapsedOffset: (ms) =>
        set({ elapsedOffset: ms }, false, "setElapsedOffset"),

      setPartialTranscript: (text) =>
        set({ partialTranscript: text }, false, "setPartialTranscript"),
      setPartialTranslation: (text) =>
        set({ partialTranslation: text }, false, "setPartialTranslation"),

      addSegment: (seg) =>
        set(
          (s) => {
            // Upsert by id: lecsync's WS path re-emits final transcripts
            // when a cloud-translation patch arrives, which would
            // otherwise create duplicate rows for the same segmentId.
            // Merge into the existing row (preserving fields the new
            // emission omits, e.g. translation accumulated separately).
            const existingIdx = s.segments.findIndex((x) => x.id === seg.id);
            if (existingIdx >= 0) {
              const merged = [...s.segments];
              merged[existingIdx] = { ...merged[existingIdx], ...seg };
              return {
                segments: merged,
                partialTranscript: seg.isFinal ? "" : s.partialTranscript,
                partialTranslation: seg.isFinal ? "" : s.partialTranslation,
              };
            }
            return {
              segments: [...s.segments, seg],
              partialTranscript: seg.isFinal ? "" : s.partialTranscript,
              partialTranslation: seg.isFinal ? "" : s.partialTranslation,
            };
          },
          false,
          "addSegment"
        ),

      updateSegment: (id, patch) =>
        set(
          (s) => ({
            segments: s.segments.map((seg) =>
              seg.id === id ? { ...seg, ...patch } : seg
            ),
          }),
          false,
          "updateSegment"
        ),

      clearTranscripts: () =>
        set(
          { segments: [], partialTranscript: "", partialTranslation: "" },
          false,
          "clearTranscripts"
        ),

      restoreSegments: (segments, translations) =>
        set(
          {
            segments,
            translations,
            partialTranscript: "",
            partialTranslation: "",
          },
          false,
          "restoreSegments"
        ),

      addTranslation: (t) =>
        set(
          (s) => ({ translations: [...s.translations, t] }),
          false,
          "addTranslation"
        ),

      updateTranslation: (segmentId, translatedText) =>
        set(
          (s) => ({
            translations: s.translations.map((t) =>
              t.segmentId === segmentId ? { ...t, translatedText } : t
            ),
          }),
          false,
          "updateTranslation"
        ),

      setDeviceStatus: (patch) =>
        set(
          (s) => ({ deviceStatus: { ...s.deviceStatus, ...patch } }),
          false,
          "setDeviceStatus"
        ),

      resetDeviceStatus: () =>
        set(
          { deviceStatus: initialDeviceStatus },
          false,
          "resetDeviceStatus"
        ),

      addConnectionGap: (gap) =>
        set(
          (s) => ({ connectionGaps: [...s.connectionGaps, gap] }),
          false,
          "addConnectionGap"
        ),

      closeConnectionGap: (id, endTime) =>
        set(
          (s) => ({
            connectionGaps: s.connectionGaps.map((g) =>
              g.id === id ? { ...g, endTime } : g
            ),
          }),
          false,
          "closeConnectionGap"
        ),

      clearConnectionGaps: () =>
        set({ connectionGaps: [] }, false, "clearConnectionGaps"),

      setError: (err) => set({ lastError: err }, false, "setError"),

      reset: () => set(initialState, false, "reset"),
    }),
    { name: "TranscriptionStore" }
  )
);

// ---------- pre-built selectors (lecsync exports these for convenience) ----------

export const selectConnectionStatus = (s: TranscriptionStore) =>
  s.connectionStatus;
export const selectDeviceStatus = (s: TranscriptionStore) => s.deviceStatus;
export const selectLatency = (s: TranscriptionStore) => s.latency;
export const selectRecordingState = (s: TranscriptionStore) => s.recordingState;
export const selectSegments = (s: TranscriptionStore) => s.segments;
export const selectPartials = (s: TranscriptionStore) => ({
  source: s.partialTranscript,
  target: s.partialTranslation,
});
