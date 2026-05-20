/**
 * LiveSharePlugin — host-side share-token push.
 *
 * Today's `Recorder` class mirrors every utterance + segment to
 * /api/live-share/{token}/push (fire-and-forget, with one retry) so
 * remote viewers see the transcript in real time. This plugin owns
 * that mirror channel:
 *
 *   - `setToken(token)` attaches/clears the share token. The plugin
 *     also writes the token through to `service.setLiveShareToken()`
 *     so the service's own config stays in sync (currently the
 *     service still reads token off config; once recorder.ts is
 *     retired we can drop that).
 *   - `service.setListeners({ onUtterance, onSegment })` pipes the
 *     two channels into the plugin without leaking live-share into
 *     the service core.
 *   - Push retries once on transient failure (matches the old
 *     `pushLiveShare` behavior); 4xx is permanent.
 *
 * The push endpoint URL is treated as a stub here — Agent C is
 * expected to land the actual /api/live-share/{token}/push route
 * (it already exists, this plugin only POSTs). If the route is not
 * yet wired the calls 404 silently; that's fine for the migration.
 */

import type { SegmentDTO, Utterance } from "@/lib/contracts";
import { transcriptionEventBus } from "@/lib/audio/event-bus";
import type { TranscriptionService } from "@/lib/audio/transcription-service";

export class LiveSharePlugin {
  private service: TranscriptionService | null = null;
  private token: string | null = null;

  init(service: TranscriptionService): void {
    this.service = service;
    service.setListeners({
      onUtterance: (u, isFinal) => this.handleUtterance(u, isFinal),
      onSegment: (seg, utteranceId) => this.handleSegment(seg, utteranceId),
    });
  }

  destroy(): void {
    this.token = null;
    this.service = null;
  }

  /** Attach/detach the share token. Pass `null` to stop mirroring. */
  setToken(token: string | null): void {
    this.token = token && token.length > 0 ? token : null;
    this.service?.setLiveShareToken(this.token);
  }

  getToken(): string | null {
    return this.token;
  }

  private handleUtterance(u: Utterance, _isFinal: boolean): void {
    this.push({ type: "utterance", utterance: u });
  }

  private handleSegment(seg: SegmentDTO, utteranceId: string | undefined): void {
    this.push({ type: "segment", segment: seg, utteranceId });
  }

  /**
   * Fire-and-forget push with one retry. Adds keepalive so a recent push
   * survives a navigation. 4xx is treated as permanent (bad token, etc).
   */
  private push(payload: object): void {
    const token = this.token;
    if (!token) return;
    const url = `/api/live-share/${encodeURIComponent(token)}/push`;
    const body = JSON.stringify(payload);
    const attempt = async (retriesLeft: number): Promise<void> => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`push rejected (${res.status})`);
        }
        if (retriesLeft > 0) {
          await new Promise((r) => setTimeout(r, 200));
          return attempt(retriesLeft - 1);
        }
        throw new Error(`push failed after retry (${res.status})`);
      } catch (err) {
        if (retriesLeft > 0) {
          await new Promise((r) => setTimeout(r, 200));
          return attempt(retriesLeft - 1);
        }
        void transcriptionEventBus.emitError({
          code: "live_share_push_failed",
          message: err instanceof Error ? err.message : String(err),
          retriable: true,
        });
      }
    };
    void attempt(1);
  }
}
