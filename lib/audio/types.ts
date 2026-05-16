/**
 * Internal types for the browser-side audio recorder.
 *
 * `contracts.ts` covers the public RecorderEvent / RecorderConfig types
 * shared with the rest of the app. This file holds the private shapes the
 * recorder uses to talk to the AudioWorklet and to interpret Soniox WS
 * payloads — they don't need to leak out of `lib/audio/`.
 */

/** Messages posted FROM the worklet TO the main thread. */
export type WorkletInboundMessage =
  | { type: "pcm"; buffer: ArrayBuffer }
  | { type: "level"; value: number };

/** Messages posted FROM the main thread TO the worklet. */
export type WorkletOutboundMessage = {
  type: "config";
  targetSampleRate: number;
};

/** Subset of Soniox token shape the recorder cares about. */
export interface SonioxToken {
  text: string;
  is_final?: boolean;
  speaker?: number | string;
  start_ms?: number;
  end_ms?: number;
  language?: string;
  translation_status?: string;
}

/** Frame received over the Soniox WebSocket. */
export interface SonioxFrame {
  tokens?: SonioxToken[];
  error_code?: number | string;
  error_message?: string;
  finished?: boolean;
}

/**
 * Private builder the recorder uses to assemble one Soniox utterance from
 * many frames before publishing as a contracts.Utterance.
 *
 * - `*Final`: text already locked in by `is_final: true` tokens; accumulates.
 * - `*Pending`: snapshot of the current in-flight guess for that channel;
 *   replaced wholesale on every Soniox frame, never appended.
 */
export interface UtteranceBuilder {
  id: string;
  speakerId: number | undefined;
  startMs: number;
  endMs: number;
  sourceFinal: string;
  sourcePending: string;
  transFinal: string;
  transPending: string;
}
