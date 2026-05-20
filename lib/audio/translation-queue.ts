/**
 * Two-priority translation queue, decompiled-and-adapted from lecsync's
 * TranslationPlugin (1e2e210db1c55512.js).
 *
 * Why a queue (and not just a setTimeout debounce):
 *
 *   - The Chrome Translator API takes 50-200ms per call. Adding a
 *     setTimeout(350) debounce on top forces every translation through
 *     a fixed 350ms floor — even when the translator could have answered
 *     in 80ms. End-to-end latency was ~450ms.
 *
 *   - This queue replaces the timer with "natural backpressure": new
 *     partials arriving while a translation is in flight just OVERWRITE
 *     the low-priority slot (only one pending partial at a time). The
 *     in-flight call's duration IS the throttle interval — no fixed
 *     debounce, no idle wait when the API is fast.
 *
 *   - Two priorities so a finalized utterance never has to wait behind
 *     a stale partial. `highPriorityQueue` is a FIFO of final segments;
 *     `lowPriorityQueue` is a single-slot "latest partial wins" buffer.
 *
 * Use:
 *
 *   const queue = new TranslationQueue();
 *   queue.setTranslator(chromeTranslator);
 *   queue.setHandlers({
 *     onResult: (job, text) => { ... },
 *     onError: (job, err) => { ... },
 *   });
 *
 *   queue.enqueue({ id, segmentId, text, priority: "low" });   // partial
 *   queue.enqueue({ id, segmentId, text, priority: "high" });  // final
 *
 * Idempotent on re-setTranslator (e.g. when the user switches language
 * pair mid-session): pending jobs drain through the old translator
 * first, then the new one takes over.
 */

export interface TranslationJob {
  id: string;
  segmentId: string;
  /** Source text to translate. */
  text: string;
  priority: "high" | "low";
  /** Wall-clock ms when the job was enqueued — caller can use it to
   *  decide if a result is still relevant. */
  timestamp: number;
}

export interface TranslatorLike {
  translate(text: string): Promise<string>;
}

export interface TranslationQueueHandlers {
  onResult: (job: TranslationJob, translated: string) => void;
  onError?: (job: TranslationJob, err: Error) => void;
}

let _idCounter = 0;
export function makeTranslationJobId(): string {
  return `tj_${Date.now()}_${++_idCounter}`;
}

export class TranslationQueue {
  private highPriorityQueue: TranslationJob[] = [];
  /** Single-slot "latest partial wins" buffer. Length is always 0 or 1. */
  private lowPrioritySlot: TranslationJob | null = null;
  private translator: TranslatorLike | null = null;
  private handlers: TranslationQueueHandlers | null = null;
  private isProcessing = false;
  private destroyed = false;

  setTranslator(translator: TranslatorLike | null): void {
    this.translator = translator;
    // Kick the loop in case jobs piled up while there was no translator.
    void this.processNext();
  }

  setHandlers(handlers: TranslationQueueHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Enqueue a job. High-priority jobs append (FIFO); low-priority jobs
   * REPLACE the single pending slot. Always triggers processNext.
   */
  enqueue(job: TranslationJob): void {
    if (this.destroyed) return;
    if (job.priority === "high") {
      this.highPriorityQueue.push(job);
    } else {
      // Latest partial wins — earlier pending partial is dropped.
      this.lowPrioritySlot = job;
    }
    void this.processNext();
  }

  /** Drop any pending jobs (e.g. when the source utterance is reset). */
  clearLowPriority(): void {
    this.lowPrioritySlot = null;
  }

  size(): { high: number; lowPending: boolean; processing: boolean } {
    return {
      high: this.highPriorityQueue.length,
      lowPending: this.lowPrioritySlot !== null,
      processing: this.isProcessing,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.highPriorityQueue = [];
    this.lowPrioritySlot = null;
    this.handlers = null;
    this.translator = null;
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.destroyed) return;
    if (!this.translator) return;
    const next =
      this.highPriorityQueue.shift() ??
      (this.lowPrioritySlot
        ? ((): TranslationJob => {
            const j = this.lowPrioritySlot!;
            this.lowPrioritySlot = null;
            return j;
          })()
        : null);
    if (!next) return;
    this.isProcessing = true;
    try {
      const translated = await this.translator.translate(next.text);
      if (this.destroyed) return;
      try {
        this.handlers?.onResult(next, translated);
      } catch (err) {
        console.warn("[TranslationQueue] onResult handler threw", err);
      }
    } catch (err) {
      if (this.destroyed) return;
      try {
        this.handlers?.onError?.(
          next,
          err instanceof Error ? err : new Error(String(err))
        );
      } catch (handlerErr) {
        console.warn("[TranslationQueue] onError handler threw", handlerErr);
      }
    } finally {
      this.isProcessing = false;
      // Drain — if more jobs arrived while we were translating, pick
      // them up immediately. The recursive call goes through the same
      // guard so it's safe even when the queue is empty.
      void this.processNext();
    }
  }
}
