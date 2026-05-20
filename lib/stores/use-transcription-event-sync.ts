/**
 * useTranscriptionEventSync — the bridge that wires the imperative
 * EventBus into the declarative Zustand store.
 *
 * Mount this once at the layout level (or anywhere that lives as long
 * as the recording engine). It subscribes to every EventBus channel
 * and dispatches the matching store action.
 *
 * Decompiled pattern from lecsync's 3e78f0446cc53587.js — the `m()`
 * function takes selectors out of the store, sets up `bus.on*` listeners
 * in a useEffect, returns nothing. Cleanup unsubscribes all listeners
 * so HMR / unmount doesn't leak.
 *
 * Special case: connectionGaps. A "gap" is the wall-clock interval
 * during which the WS was reconnecting / disconnected / errored while
 * the user was actively recording. We open a gap when the status
 * enters one of those values, close it when status returns to
 * connected. The ref-held gapId survives re-renders.
 */

"use client";

import * as React from "react";

import { transcriptionEventBus } from "@/lib/audio/event-bus";
import { useTranscriptionStore } from "./transcription-store";

export function useTranscriptionEventSync(): void {
  // Pull stable action refs out of the store. Zustand actions are
  // referentially stable across renders so these selectors are fine.
  const setPartialTranscript = useTranscriptionStore((s) => s.setPartialTranscript);
  const setPartialTranslation = useTranscriptionStore((s) => s.setPartialTranslation);
  const addSegment = useTranscriptionStore((s) => s.addSegment);
  const updateSegment = useTranscriptionStore((s) => s.updateSegment);
  const addTranslation = useTranscriptionStore((s) => s.addTranslation);
  const updateTranslation = useTranscriptionStore((s) => s.updateTranslation);
  const setConnectionStatus = useTranscriptionStore((s) => s.setConnectionStatus);
  const setLatency = useTranscriptionStore((s) => s.setLatency);
  const setError = useTranscriptionStore((s) => s.setError);
  const setDeviceStatus = useTranscriptionStore((s) => s.setDeviceStatus);
  const addConnectionGap = useTranscriptionStore((s) => s.addConnectionGap);
  const closeConnectionGap = useTranscriptionStore((s) => s.closeConnectionGap);

  /** id of the currently-open connection gap, if any */
  const openGapId = React.useRef<string | null>(null);

  React.useEffect(() => {
    const bus = transcriptionEventBus;

    const subs = [
      // ---- transcripts ----
      bus.onPartialTranscript((env) => {
        setPartialTranscript(env.data.text);
      }),
      bus.onFinalTranscript((env) => {
        addSegment({
          id: env.data.segmentId,
          text: env.data.text,
          timestamp: env.timestamp,
          isFinal: true,
          confidence: env.data.confidence,
          speaker: env.data.speaker,
          startMs: env.data.startMs,
          endMs: env.data.endMs,
        });
      }),

      // ---- translations ----
      bus.onPartialTranslation((env) => {
        setPartialTranslation(env.data.text);
      }),
      bus.onFinalTranslation((env) => {
        // If the segment exists, prefer updating its translated field
        // directly (single source of truth). Otherwise append to the
        // translations side-list.
        const exists =
          useTranscriptionStore
            .getState()
            .segments.some((s) => s.id === env.data.segmentId);
        if (exists) {
          updateSegment(env.data.segmentId, {
            // Future: when Segment gains a translatedText field we'll
            // write here directly. For now we still maintain the
            // parallel translations list.
          });
          updateTranslation(env.data.segmentId, env.data.translatedText);
          // updateTranslation is a no-op if the row doesn't exist; add
          // so the first translation for a segment lands.
          const hasRow = useTranscriptionStore
            .getState()
            .translations.some((t) => t.segmentId === env.data.segmentId);
          if (!hasRow) {
            addTranslation({
              segmentId: env.data.segmentId,
              translatedText: env.data.translatedText,
              timestamp: env.timestamp,
            });
          }
        } else {
          addTranslation({
            segmentId: env.data.segmentId,
            translatedText: env.data.translatedText,
            timestamp: env.timestamp,
          });
        }
      }),

      // ---- connection ----
      bus.onConnectionStatus((env) => {
        setConnectionStatus(env.data.status, env.data.sessionId);
        if (typeof env.data.latency === "number") {
          setLatency(env.data.latency);
        }
        // ConnectionGap open/close logic.
        const recording =
          useTranscriptionStore.getState().recordingState === "recording";
        const isOutage =
          env.data.status === "reconnecting" ||
          env.data.status === "disconnected" ||
          env.data.status === "error";

        if (isOutage && recording) {
          if (!openGapId.current) {
            const id = `gap_${Date.now()}`;
            openGapId.current = id;
            addConnectionGap({ id, startTime: Date.now() });
          }
        } else if (openGapId.current && env.data.status === "connected") {
          closeConnectionGap(openGapId.current, Date.now());
          openGapId.current = null;
        }
      }),

      // ---- errors ----
      bus.onError((env) => {
        setError({
          code: env.data.code,
          message: env.data.message,
          retriable: env.data.retriable,
        });
      }),

      // ---- device ----
      bus.onDeviceDisconnected((env) => {
        setDeviceStatus({
          isConnected: false,
          isRecovering: true,
          deviceLabel: env.data.deviceLabel,
        });
      }),
      bus.onDeviceRecovered((env) => {
        setDeviceStatus({
          isConnected: true,
          isRecovering: false,
          deviceLabel: env.data.deviceLabel,
          isFallback: env.data.attempts > 0,
          recoveryFailed: false,
        });
      }),
      bus.onDeviceRecoveryFailed((env) => {
        setDeviceStatus({
          isConnected: false,
          isRecovering: false,
          deviceLabel: env.data.deviceLabel,
          recoveryFailed: true,
        });
      }),

      // ---- audio ----
      bus.onAudioSilence((env) => {
        setDeviceStatus({
          silenceWarningMs: env.data.durationMs,
          silenceIsDeviceFault: env.data.isDeviceFault,
        });
      }),
      bus.onAudioContextStateChange(() => {
        // No-op for now — the AudioContext state itself is informational.
        // If a future UI wants to show "browser suspended audio", read
        // from device status or add a dedicated field.
      }),
    ];

    return () => {
      subs.forEach((s) => s.unsubscribe());
      // Close any still-open gap so the next mount starts clean.
      if (openGapId.current) {
        closeConnectionGap(openGapId.current, Date.now());
        openGapId.current = null;
      }
    };
  }, [
    setPartialTranscript,
    setPartialTranslation,
    addSegment,
    updateSegment,
    addTranslation,
    updateTranslation,
    setConnectionStatus,
    setLatency,
    setError,
    setDeviceStatus,
    addConnectionGap,
    closeConnectionGap,
  ]);
}
