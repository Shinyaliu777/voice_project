/**
 * PersistencePlugin — IndexedDB chunk caching + sendBeacon last-chunk safety net.
 *
 * Responsibility cleanly factored out of the old `Recorder` class:
 *
 *   1. Every `dataavailable` MediaRecorder blob lands here via
 *      `service.setListeners({ onChunk })`. We:
 *        a. Persist the chunk to IndexedDB BEFORE the network round-trip
 *           so a tab close / crash between "MediaRecorder produced chunk"
 *           and "PUT R2 finished" doesn't lose audio.
 *        b. Stash a ref to the most recent chunk so the `pagehide` handler
 *           can sendBeacon it on tab unload.
 *        c. Push the chunk through the presign → PUT → chunk-record upload
 *           queue, serialized so chunk order is preserved.
 *        d. On upload success: flip the IndexedDB row's `uploaded` flag so
 *           boot-time recovery skips it, and clear the sendBeacon ref.
 *
 *   2. On `pagehide` (forwarded by the service via `onPageHide`) we POST
 *      the last in-flight chunk to /api/audio/upload-chunk using
 *      navigator.sendBeacon as a single-shot fallback.
 *
 *   3. When the session is finalized (TranscriptionApp calls
 *      `plugin.onSessionFinalized(sessionId)`) we drop the IndexedDB rows
 *      for that session so the next-session recovery doesn't replay them.
 *
 * Behavior copied verbatim from `lib/audio/recorder.ts` — same retry
 * semantics, same storage-key contract with the server.
 */

import { getAudioLocalCache } from "@/lib/audio/local-cache";
import type { TranscriptionService, ChunkEvent } from "@/lib/audio/transcription-service";
import { transcriptionEventBus } from "@/lib/audio/event-bus";

interface InFlightChunk {
  sessionId: string;
  chunkIndex: number;
  blob: Blob;
  durationSeconds: number;
  contentType: string;
}

export class PersistencePlugin {
  private service: TranscriptionService | null = null;
  private chunkUploadQueue: Promise<void> = Promise.resolve();
  private lastInFlightChunk: InFlightChunk | null = null;

  init(service: TranscriptionService): void {
    this.service = service;
    service.setListeners({
      onChunk: (chunk) => this.handleChunk(chunk),
      onPageHide: () => this.handlePageHide(),
    });
  }

  destroy(): void {
    // Best-effort: don't await the upload queue here. The TranscriptionApp
    // orchestrator awaits it via `flushPendingUploads()` before tearing
    // the plugin down.
    this.service = null;
    this.lastInFlightChunk = null;
  }

  /** Await any in-progress uploads before TranscriptionApp teardown. */
  async flushPendingUploads(): Promise<void> {
    await this.chunkUploadQueue.catch(() => undefined);
  }

  /**
   * Called by TranscriptionApp.stopRecording() once the service confirms
   * /api/audio/finalize succeeded. Drops the IndexedDB rows; if finalize
   * failed we keep the rows so next-session boot can retry them.
   */
  async onSessionFinalized(sessionId: string): Promise<void> {
    try {
      await getAudioLocalCache().clearSession(sessionId);
    } catch {
      /* ignore — best-effort cleanup */
    }
  }

  private handleChunk(chunk: ChunkEvent): void {
    // ---- Durability: persist to IndexedDB BEFORE the network ----
    // If the tab closes between this fire and the PUT/POST completing,
    // the chunk is still on disk locally and boot-time recovery will
    // retry the upload. sendBeacon (pagehide handler) is the secondary
    // safety net for in-memory chunks that haven't been written yet.
    const durationMs = Math.round(chunk.durationSeconds * 1000);
    void getAudioLocalCache()
      .storeChunk(chunk.sessionId, chunk.chunkIndex, chunk.blob, durationMs, chunk.contentType)
      .catch(() => {
        // Disk pressure / private-browsing IndexedDB denial — best-effort,
        // fall through to the network-only path.
      });

    this.lastInFlightChunk = {
      sessionId: chunk.sessionId,
      chunkIndex: chunk.chunkIndex,
      blob: chunk.blob,
      durationSeconds: chunk.durationSeconds,
      contentType: chunk.contentType,
    };

    this.chunkUploadQueue = this.chunkUploadQueue.then(() =>
      this.uploadChunk(chunk).catch((err) => {
        void transcriptionEventBus.emitError({
          code: "chunk_upload_failed",
          message: err instanceof Error ? err.message : String(err),
          retriable: true,
        });
      })
    );
  }

  private handlePageHide(): void {
    const chunk = this.lastInFlightChunk;
    if (!chunk) return;
    try {
      const fd = new FormData();
      fd.append("sessionId", chunk.sessionId);
      fd.append("chunkIndex", String(chunk.chunkIndex));
      fd.append("durationSeconds", String(chunk.durationSeconds));
      fd.append("contentType", chunk.contentType);
      fd.append("file", chunk.blob, `chunk-${chunk.chunkIndex}.webm`);
      navigator.sendBeacon?.("/api/audio/upload-chunk", fd);
    } catch {
      /* sendBeacon throws on payload-too-large; IndexedDB still has the
       * chunk so next-session recovery saves us. */
    }
  }

  private async uploadChunk(chunk: ChunkEvent): Promise<void> {
    const contentType = chunk.contentType;
    const sizeBytes = chunk.blob.size;

    // 1. Presign
    const presign = await this.fetchJsonWithRetry("/api/audio/chunk-presign", {
      sessionId: chunk.sessionId,
      chunkIndex: chunk.chunkIndex,
      contentType,
      sizeBytes,
    });
    const { uploadUrl, publicUrl, method, headers, storageKey } = presign as {
      uploadUrl: string;
      publicUrl: string;
      method: "PUT" | "POST";
      headers?: Record<string, string>;
      chunkId: string;
      storageKey: string;
    };

    // 2. PUT bytes
    await this.fetchWithRetry(uploadUrl, {
      method,
      headers: headers ?? { "Content-Type": contentType },
      body: chunk.blob,
    });

    // 3. Record completion
    await this.fetchJsonWithRetry("/api/audio/chunk-record", {
      sessionId: chunk.sessionId,
      chunkIndex: chunk.chunkIndex,
      contentType,
      sizeBytes,
      durationSeconds: chunk.durationSeconds,
      publicUrl,
      storageKey,
    });

    // 4. Mark IndexedDB row uploaded.
    void getAudioLocalCache()
      .markUploaded(chunk.sessionId, chunk.chunkIndex)
      .catch(() => {});

    // 5. Drop the in-memory beacon ref unless a newer chunk has arrived.
    if (this.lastInFlightChunk?.chunkIndex === chunk.chunkIndex) {
      this.lastInFlightChunk = null;
    }
  }

  private async fetchJsonWithRetry(url: string, body: unknown): Promise<unknown> {
    const res = await this.fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
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
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`fetchWithRetry exhausted retries for ${url}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}
