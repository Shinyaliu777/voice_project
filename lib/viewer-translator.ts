/**
 * Viewer-side translator cache for the public live-share page.
 *
 * Mirrors `getOrCreateChromeTranslator` from `lib/audio/recorder.ts` — keeps
 * a per-pair singleton so the first translation pays the model warmup cost
 * once and subsequent translations are instant.
 *
 * IMPORTANT: we MUST check `Translator.availability(...)` before calling
 * `create()`. Without that check, `create()` on a "downloadable" pair throws
 * with "user gesture required" because the viewer-side translator change is
 * driven by a Select onValueChange callback that has already lost its user
 * gesture by the time we reach this code path (the Select primitive defers
 * the change). See commit b3ae041 era — the recorder hit the same issue and
 * we fixed it by gating on availability first.
 *
 * Returns null when:
 *   - window.Translator is missing (non-Chrome / flag off)
 *   - availability is "downloadable" (model not yet installed)
 *   - availability is "unavailable" (pair not supported)
 *   - create() rejects for any other reason
 *
 * Callers should toast + keep the existing translation when null is returned.
 */

interface ChromeTranslatorAPI {
  availability(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<string>;
  create(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<ChromeTranslatorInstance>;
}

export interface ChromeTranslatorInstance {
  translate(text: string): Promise<string>;
}

function readTranslator(): ChromeTranslatorAPI | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { Translator?: ChromeTranslatorAPI };
  return w.Translator ?? null;
}

/**
 * Per-pair cache, keyed `${src}->${tgt}`. We store the Promise so concurrent
 * callers share a single warmup.
 */
const translatorCache = new Map<
  string,
  Promise<ChromeTranslatorInstance | null>
>();

/**
 * Returns a Chrome Translator for the given pair, or null if it can't be
 * created here (no API, model not installed, or unsupported pair).
 *
 * Same instance is returned for repeat calls with the same pair — cheap to
 * use in render-adjacent code paths.
 */
export function getOrCreateViewerTranslator(
  sourceLanguage: string,
  targetLanguage: string
): Promise<ChromeTranslatorInstance | null> {
  if (sourceLanguage === targetLanguage) {
    return Promise.resolve(null);
  }
  const key = `${sourceLanguage}->${targetLanguage}`;
  const cached = translatorCache.get(key);
  if (cached) return cached;

  const T = readTranslator();
  if (!T) {
    return Promise.resolve(null);
  }

  const promise: Promise<ChromeTranslatorInstance | null> = (async () => {
    try {
      // Availability gate — without this, create() on a "downloadable" pair
      // throws "user gesture required" (the Select onChange callback has lost
      // the original gesture). Only "available" and "downloading" are safe
      // to create from a non-gesture context.
      const a = await T.availability({
        sourceLanguage,
        targetLanguage,
      });
      if (a !== "available" && a !== "downloading") {
        translatorCache.delete(key);
        return null;
      }
      return await T.create({ sourceLanguage, targetLanguage });
    } catch {
      translatorCache.delete(key);
      return null;
    }
  })();

  translatorCache.set(key, promise);
  return promise;
}

/** Cheap probe — returns true if the runtime has the API at all. */
export function hasViewerTranslatorAPI(): boolean {
  return readTranslator() != null;
}

/**
 * Probe availability without creating. Returns the raw availability string
 * ("available" / "downloading" / "downloadable" / "unavailable") or null
 * if the API isn't present.
 */
export async function probeViewerTranslator(
  sourceLanguage: string,
  targetLanguage: string
): Promise<string | null> {
  const T = readTranslator();
  if (!T) return null;
  try {
    return await T.availability({ sourceLanguage, targetLanguage });
  } catch {
    return null;
  }
}
