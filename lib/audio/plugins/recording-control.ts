/**
 * RecordingControlPlugin — recording queue client (stub).
 *
 * Mirrors lecsync's `recordingControlPlugin` which talks to a server-side
 * queue at /api/recording/{start, queue-status, release}. The queue lets
 * the server enforce per-tenant concurrency (e.g. "only one mic per
 * account at a time") and provides a graceful "you are queued" UX
 * instead of failing the start call outright.
 *
 * Agent D owns the API routes. Until those land this plugin is a stub:
 *
 *   - `requestStart(sessionId)` returns `{ status: "ready" }` immediately
 *     so TranscriptionApp's startRecording() flow stays unblocked.
 *   - `release(sessionId)` is a no-op.
 *
 * Once the real endpoints exist, swap the stub bodies for real fetches
 * without touching TranscriptionApp.
 */

import type { TranscriptionService } from "@/lib/audio/transcription-service";

export type QueueStatus =
  | { status: "ready" }
  | { status: "queued"; positionInQueue: number; estimatedWaitMs?: number }
  | { status: "denied"; reason: string };

export class RecordingControlPlugin {
  private service: TranscriptionService | null = null;
  private activeSessionId: string | null = null;

  init(service: TranscriptionService): void {
    this.service = service;
  }

  destroy(): void {
    // Best-effort release on teardown.
    if (this.activeSessionId) {
      void this.release(this.activeSessionId).catch(() => {});
    }
    this.activeSessionId = null;
    this.service = null;
  }

  /**
   * Ask the server whether we can start recording. Today this is a stub
   * returning ready — once /api/recording/start exists, replace with a
   * real fetch and surface queue status to the UI.
   */
  async requestStart(sessionId: string): Promise<QueueStatus> {
    this.activeSessionId = sessionId;
    return { status: "ready" };
  }

  /**
   * Poll the server for queue position while we're waiting. Stub: always
   * "ready". Real implementation will GET /api/recording/queue-status.
   */
  async checkQueueStatus(sessionId: string): Promise<QueueStatus> {
    void sessionId;
    return { status: "ready" };
  }

  /**
   * Release the recording slot back to the queue. Called from
   * TranscriptionApp.stopRecording(). Stub: no-op. Real implementation
   * will POST /api/recording/release.
   */
  async release(sessionId: string): Promise<void> {
    void sessionId;
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
  }
}
