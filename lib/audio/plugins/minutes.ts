/**
 * MinutesPlugin — incremental live minutes via /api/minutes/stream SSE.
 *
 * Logic mirrors the in-component pipeline currently living in
 * `components/Recorder.tsx` (the `refreshLiveMinutes` callback + auto-
 * refresh effect). Pulled into a standalone plugin so the orchestrator
 * can compose it without baking minutes into the UI shell.
 *
 * Flow:
 *   - Subscribes to `transcriptionEventBus.onFinalTranscript` to collect
 *     newly-finalized utterances in a local FIFO.
 *   - When `>= MIN_NEW_TRANSCRIPTS` or `>= MIN_CHARS_DELTA` have accumulated
 *     and no stream is in flight, POSTs `{ mode: "incremental", ... }`
 *     and streams the SSE response. Each `incremental_update` mutates the
 *     local confirmed/pending state and is fanned out to subscribers via
 *     `onMinutesUpdate(handler)` so the UI can render.
 *   - Tracks sent ids so we never double-send a transcript.
 *   - All requests are abortable; `destroy()` cancels in flight.
 *
 * The UI subscribes to this plugin (via TranscriptionApp.getMinutesPlugin())
 * to render the live minutes panel without holding any /api/minutes/stream
 * logic itself.
 */

import type {
  IncrementalMinutesSection,
  IncrementalMinutesUpdate,
  MinutesSection,
  MinutesStreamEvent,
} from "@/lib/contracts";
import { transcriptionEventBus } from "@/lib/audio/event-bus";
import type { Subscription } from "@/lib/audio/event-bus";
import type { TranscriptionService } from "@/lib/audio/transcription-service";

export interface MinutesState {
  confirmedSections: MinutesSection[];
  pendingSection: MinutesSection | null;
  status: "idle" | "streaming" | "error";
}

export type MinutesSubscriber = (state: MinutesState) => void;

interface PendingTranscript {
  segmentId: string;
  text: string;
  /** ms since recording started */
  timestamp: number;
}

export class MinutesPlugin {
  private service: TranscriptionService | null = null;
  private busSubscription: Subscription | null = null;
  private subscribers = new Set<MinutesSubscriber>();

  private state: MinutesState = {
    confirmedSections: [],
    pendingSection: null,
    status: "idle",
  };

  /** Delta queue — transcripts whose utterance id has not yet been sent. */
  private pending: PendingTranscript[] = [];
  private sentIds = new Set<string>();

  private abortController: AbortController | null = null;
  private autoRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set when the plugin should fan out to /api/minutes/stream. */
  private sessionId: string | null = null;
  private language: string = "zh";
  private startedAtMs: number | null = null;

  /** Trigger a refresh once this many new transcripts have accumulated. */
  private readonly MIN_NEW_TRANSCRIPTS = 1;
  /** Or this many new chars (whichever fires first). */
  private readonly MIN_CHARS_DELTA = 80;
  /** Auto-refresh debounce — wait this long after a new final before firing. */
  private readonly AUTO_REFRESH_DEBOUNCE_MS = 2500;

  init(service: TranscriptionService): void {
    this.service = service;
    this.busSubscription = transcriptionEventBus.onFinalTranscript((env) => {
      const text = (env.data.text ?? "").trim();
      if (text.length < 3) {
        // Skip but pretend-mark so we don't reconsider later.
        this.sentIds.add(env.data.segmentId);
        return;
      }
      if (this.sentIds.has(env.data.segmentId)) return;
      const timestamp = Math.max(
        0,
        typeof env.data.startMs === "number" ? env.data.startMs : 0
      );
      this.pending.push({ segmentId: env.data.segmentId, text, timestamp });
      this.scheduleAutoRefresh();
    });
  }

  destroy(): void {
    this.busSubscription?.unsubscribe();
    this.busSubscription = null;
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    this.subscribers.clear();
    this.service = null;
    this.pending = [];
    this.sentIds.clear();
    this.sessionId = null;
  }

  /** Called by TranscriptionApp.startRecording() once it knows the DB session id. */
  attachSession(sessionId: string, opts?: { language?: string; startedAtMs?: number }): void {
    this.sessionId = sessionId;
    this.language = opts?.language ?? this.language;
    this.startedAtMs = opts?.startedAtMs ?? Date.now();
    // Clear prior state on a fresh session.
    this.state = { confirmedSections: [], pendingSection: null, status: "idle" };
    this.pending = [];
    this.sentIds.clear();
    this.notify();
  }

  /** Detach when the recording stops — pending transcripts will not be sent. */
  detachSession(): void {
    this.sessionId = null;
    this.abortController?.abort();
    this.abortController = null;
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  getState(): MinutesState {
    return this.state;
  }

  /** Subscribe to minutes state changes (React component reads here). */
  subscribe(handler: MinutesSubscriber): () => void {
    this.subscribers.add(handler);
    handler(this.state);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Force an immediate refresh (UI "刷新纪要" button). */
  async refresh(opts?: { silent?: boolean }): Promise<void> {
    await this.runRefresh(opts);
  }

  private scheduleAutoRefresh(): void {
    if (!this.sessionId) return;
    if (this.state.status === "streaming") return;
    const totalChars = this.pending.reduce((acc, p) => acc + p.text.length, 0);
    const ready =
      this.pending.length >= this.MIN_NEW_TRANSCRIPTS &&
      totalChars >= this.MIN_CHARS_DELTA;
    if (!ready) return;
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = null;
      void this.runRefresh({ silent: true });
    }, this.AUTO_REFRESH_DEBOUNCE_MS);
  }

  private async runRefresh(opts?: { silent?: boolean }): Promise<void> {
    if (!this.sessionId) return;
    if (this.state.status === "streaming") return;
    if (this.pending.length === 0) return;

    const newTranscripts = this.pending.slice();
    const justSentIds = newTranscripts.map((p) => p.segmentId);

    this.abortController?.abort();
    const ctrl = new AbortController();
    this.abortController = ctrl;
    this.state = { ...this.state, status: "streaming" };
    this.notify();

    try {
      const resp = await fetch(`/api/sessions/${this.sessionId}/minutes/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "incremental",
          confirmedSections: this.state.confirmedSections.map(toIncrementalSection),
          pendingSection: this.state.pendingSection
            ? toIncrementalSection(this.state.pendingSection)
            : null,
          newTranscripts,
          language: this.language,
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`Failed to stream minutes (${resp.status})`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const evt of events) {
          const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let payload: MinutesStreamEvent;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (payload.type === "incremental_update") {
            // Mark the delta as consumed only after a successful update.
            for (const id of justSentIds) this.sentIds.add(id);
            this.applyIncremental(payload.update);
            this.notify();
          } else if (payload.type === "error") {
            throw new Error(payload.message);
          }
        }
      }
      // Drop the consumed transcripts from the pending FIFO.
      this.pending = this.pending.filter((p) => !this.sentIds.has(p.segmentId));
      this.state = { ...this.state, status: "idle" };
      this.notify();
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        // Swallow — the next runRefresh will pick up the same delta.
        return;
      }
      this.state = { ...this.state, status: "error" };
      this.notify();
      if (!opts?.silent) {
        void transcriptionEventBus.emitError({
          code: "minutes_refresh_failed",
          message: err instanceof Error ? err.message : String(err),
          retriable: true,
        });
      }
    }
  }

  private applyIncremental(update: IncrementalMinutesUpdate): void {
    const { topicChanged, currentTopic } = update;
    const newNarrative = (currentTopic.newNarrative ?? "").trim();
    const hasNarrativeDelta = newNarrative.length > 0;
    const startedAt = this.startedAtMs ?? Date.now();
    const elapsed = Math.max(0, Date.now() - startedAt);

    if (topicChanged && this.state.pendingSection) {
      this.state = {
        ...this.state,
        confirmedSections: [...this.state.confirmedSections, this.state.pendingSection],
        pendingSection: {
          title: currentTopic.title || "新话题",
          narrative: hasNarrativeDelta ? newNarrative : undefined,
          points: hasNarrativeDelta ? [] : currentTopic.newPoints,
          timeStartMs: currentTopic.timeStartMs,
          timeEndMs: currentTopic.timeEndMs,
        },
      };
    } else if (this.state.pendingSection) {
      const prev = this.state.pendingSection;
      const prevNarrative = prev.narrative ?? "";
      const mergedNarrative = hasNarrativeDelta
        ? (prevNarrative ? `${prevNarrative}\n\n${newNarrative}` : newNarrative)
        : prevNarrative || undefined;
      this.state = {
        ...this.state,
        pendingSection: {
          title: currentTopic.title || prev.title,
          narrative: mergedNarrative,
          points: hasNarrativeDelta ? prev.points : [...prev.points, ...currentTopic.newPoints],
          timeStartMs: prev.timeStartMs ?? currentTopic.timeStartMs,
          timeEndMs: currentTopic.timeEndMs ?? prev.timeEndMs,
        },
      };
    } else {
      this.state = {
        ...this.state,
        pendingSection: {
          title: currentTopic.title || "话题 1",
          narrative: hasNarrativeDelta ? newNarrative : undefined,
          points: hasNarrativeDelta ? [] : currentTopic.newPoints,
          timeStartMs: currentTopic.timeStartMs ?? elapsed,
          timeEndMs: currentTopic.timeEndMs,
        },
      };
    }
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try { cb(this.state); } catch { /* swallow */ }
    }
  }
}

function toIncrementalSection(s: MinutesSection): IncrementalMinutesSection {
  return {
    title: s.title,
    narrative: s.narrative,
    points: s.points,
    timeStartMs: s.timeStartMs,
    timeEndMs: s.timeEndMs,
  };
}
