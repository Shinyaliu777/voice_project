/**
 * TranscriptionAppProvider — React Context bridge for the imperative engine.
 *
 * Owns a single `TranscriptionApp` instance via `useRef`. The instance
 * lives across renders and is destroyed only when the provider unmounts.
 * Any descendant page calls `useTranscriptionApp()` to grab handles to
 * the engine plus the plugin getters.
 *
 *   <TranscriptionAppProvider>
 *     <DashboardLayout>...</DashboardLayout>
 *   </TranscriptionAppProvider>
 *
 *   function Page() {
 *     const { startRecording, stopRecording, isInitialized, pipPlugin } =
 *       useTranscriptionApp();
 *     ...
 *   }
 *
 * The provider intentionally does NOT auto-construct the engine at mount.
 * The engine has nothing useful to do until `startRecording(config)` is
 * called — there's no "logged in but idle" engine state worth keeping
 * warm. Browser-support probes are exposed via the static method on
 * `TranscriptionApp` so the UI can disable buttons without spinning up
 * a service.
 *
 * NOTE: per the migration plan (lib/audio/recorder.ts is still the live
 * implementation), this Provider is NOT mounted at app/(app)/layout.tsx
 * yet. The follow-up swap is described in `voice_project_lecsync_strategies.md`.
 */

"use client";

import * as React from "react";

import type { RecorderConfig, RecorderState } from "@/lib/contracts";
import {
  TranscriptionApp,
  type BrowserSupport,
  type StartRecordingOptions,
} from "@/lib/audio/transcription-app";
import { useTranscriptionEventSync } from "@/lib/stores/use-transcription-event-sync";
import type { IdleDetectionPlugin } from "@/lib/audio/plugins/idle-detection";
import type { LiveSharePlugin } from "@/lib/audio/plugins/live-share";
import type { MinutesPlugin } from "@/lib/audio/plugins/minutes";
import type { PersistencePlugin } from "@/lib/audio/plugins/persistence";
import type { PipPlugin } from "@/lib/audio/plugins/pip";
import type { RecordingControlPlugin } from "@/lib/audio/plugins/recording-control";

export interface TranscriptionAppContextValue {
  /** True once the underlying engine instance has been constructed. */
  isInitialized: boolean;
  /** True while a `startRecording()` call is in flight. */
  isStarting: boolean;
  /** True if the engine is currently recording. */
  isRecording: boolean;
  /** Last error surfaced by `startRecording`. */
  initError: string | null;

  /** Convenience: current service state (idle / recording / paused / ...). */
  state: RecorderState;
  /** Browser support snapshot — pre-computed once on mount. */
  browserSupport: BrowserSupport;

  /** Imperative controls. */
  startRecording(
    config: RecorderConfig,
    options?: StartRecordingOptions
  ): Promise<void>;
  stopRecording(): Promise<void>;
  /** Raw engine handle — for advanced consumers (debugger overlay etc.). */
  getApp(): TranscriptionApp | null;

  /** Plugin getters. Stable references across renders so consumers can
   *  hold them in deps arrays. */
  persistencePlugin: PersistencePlugin | null;
  minutesPlugin: MinutesPlugin | null;
  liveSharePlugin: LiveSharePlugin | null;
  idleDetectionPlugin: IdleDetectionPlugin | null;
  recordingControlPlugin: RecordingControlPlugin | null;
  pipPlugin: PipPlugin | null;
}

const TranscriptionAppContext = React.createContext<TranscriptionAppContextValue | null>(null);

export interface TranscriptionAppProviderProps {
  children: React.ReactNode;
}

export function TranscriptionAppProvider({ children }: TranscriptionAppProviderProps) {
  // Bridge EventBus events into the Zustand TranscriptionStore so any
  // consumer of useTranscriptionStore stays in sync with the engine.
  // Mounting it inside the Provider means it's tied to the same
  // lifecycle as the engine ref below — no one has to remember to
  // mount the hook separately.
  useTranscriptionEventSync();

  const appRef = React.useRef<TranscriptionApp | null>(null);
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [isStarting, setIsStarting] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState(false);
  const [initError, setInitError] = React.useState<string | null>(null);
  const [state, setState] = React.useState<RecorderState>("idle");
  const [browserSupport] = React.useState<BrowserSupport>(() =>
    TranscriptionApp.checkBrowserSupport()
  );

  // Lazily construct the engine on first mount. We don't tear it down
  // until the provider itself unmounts — recording can stop and restart
  // multiple times across a single provider lifetime.
  const getApp = React.useCallback((): TranscriptionApp | null => {
    if (!appRef.current) {
      appRef.current = new TranscriptionApp();
      setIsInitialized(true);
    }
    return appRef.current;
  }, []);

  // Poll engine state once a second while a recording is active so the
  // context value stays accurate. Cheap (state is a plain string) and
  // avoids forcing every plugin to push state-change events. Once the
  // EventBus grows a "recording_state_changed" channel we can swap to
  // event-driven.
  React.useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => {
      const app = appRef.current;
      if (!app) return;
      const next = app.getState();
      setState(next);
      if (next !== "recording" && next !== "paused" && next !== "reconnecting") {
        setIsRecording(false);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  // Cleanup on unmount — best-effort. We intentionally don't await
  // destroy() in the cleanup function (React effects can't await).
  React.useEffect(() => {
    return () => {
      const app = appRef.current;
      if (!app) return;
      void app.destroy().catch(() => {});
      appRef.current = null;
    };
  }, []);

  const startRecording = React.useCallback(
    async (config: RecorderConfig, options?: StartRecordingOptions) => {
      const app = getApp();
      if (!app) return;
      setIsStarting(true);
      setInitError(null);
      try {
        await app.startRecording(config, options);
        setIsRecording(true);
        setState(app.getState());
      } catch (err) {
        const msg = err instanceof Error ? err.message : "无法启动录音";
        setInitError(msg);
        setIsRecording(false);
        throw err;
      } finally {
        setIsStarting(false);
      }
    },
    [getApp]
  );

  const stopRecording = React.useCallback(async () => {
    const app = appRef.current;
    if (!app) return;
    try {
      await app.stopRecording();
    } finally {
      setIsRecording(false);
      setState(app.getState());
    }
  }, []);

  // Plugin handles — once the engine is constructed they're stable for
  // the lifetime of the provider.
  const value = React.useMemo<TranscriptionAppContextValue>(() => {
    const app = appRef.current;
    return {
      isInitialized,
      isStarting,
      isRecording,
      initError,
      state,
      browserSupport,
      startRecording,
      stopRecording,
      getApp: () => appRef.current,
      persistencePlugin: app?.getPersistencePlugin() ?? null,
      minutesPlugin: app?.getMinutesPlugin() ?? null,
      liveSharePlugin: app?.getLiveSharePlugin() ?? null,
      idleDetectionPlugin: app?.getIdleDetectionPlugin() ?? null,
      recordingControlPlugin: app?.getRecordingControlPlugin() ?? null,
      pipPlugin: app?.getPipPlugin() ?? null,
    };
  }, [
    isInitialized,
    isStarting,
    isRecording,
    initError,
    state,
    browserSupport,
    startRecording,
    stopRecording,
  ]);

  return (
    <TranscriptionAppContext.Provider value={value}>
      {children}
    </TranscriptionAppContext.Provider>
  );
}

export function useTranscriptionApp(): TranscriptionAppContextValue {
  const ctx = React.useContext(TranscriptionAppContext);
  if (!ctx) {
    throw new Error(
      "useTranscriptionApp() must be called inside <TranscriptionAppProvider>"
    );
  }
  return ctx;
}

/** Same as `useTranscriptionApp` but returns null if no provider is mounted —
 *  useful for components that work both with and without the engine wired in. */
export function useOptionalTranscriptionApp(): TranscriptionAppContextValue | null {
  return React.useContext(TranscriptionAppContext);
}
