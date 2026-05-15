import type { TranslationProvider } from "@/lib/contracts";

declare global {
  interface Window {
    Translator?: {
      create(options: {
        sourceLanguage: string;
        targetLanguage: string;
      }): Promise<{ translate(text: string): Promise<string> }>;
      availability?(options: {
        sourceLanguage: string;
        targetLanguage: string;
      }): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
    };
  }
}
export {};

type TranslatorInstance = { translate(text: string): Promise<string> };

const instanceCache = new Map<string, Promise<TranslatorInstance>>();

function getTranslatorApi() {
  // The API is exposed both on `window` and on `globalThis` in Chrome.
  // Read via `globalThis` so this file is safe to import in code paths that
  // also touch SSR (it just won't be used until called).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  return g?.Translator as Window["Translator"];
}

function key(sourceLanguage: string, targetLanguage: string): string {
  return `${sourceLanguage}->${targetLanguage}`;
}

async function getTranslator(
  sourceLanguage: string,
  targetLanguage: string
): Promise<TranslatorInstance> {
  const Translator = getTranslatorApi();
  if (!Translator) {
    throw new Error(
      "Chrome Translator API unavailable; requires Chrome 138+ or Edge with translator API enabled"
    );
  }
  const k = key(sourceLanguage, targetLanguage);
  const cached = instanceCache.get(k);
  if (cached) return cached;
  const p = Translator.create({ sourceLanguage, targetLanguage });
  instanceCache.set(k, p);
  try {
    return await p;
  } catch (err) {
    // Don't cache failed instantiations.
    instanceCache.delete(k);
    throw err;
  }
}

/**
 * Browser-side translation provider that wraps Chrome's on-device
 * `window.Translator` API. Falls back nowhere — callers should switch to a
 * server provider if `isChromeTranslatorAvailable()` returns false.
 */
export const chromeLocalProvider: TranslationProvider = {
  id: "chrome-local",
  async translate(req) {
    const translator = await getTranslator(req.sourceLanguage, req.targetLanguage);
    const translatedText = await translator.translate(req.text);
    return {
      translatedText,
      translationSource: "chrome-local",
    };
  },
};

/**
 * Probe whether the Chrome Translator API is present and reports a usable
 * (or downloadable) en→zh model. Returns false on any error so callers can
 * treat it as a simple feature flag.
 */
export async function isChromeTranslatorAvailable(): Promise<boolean> {
  const Translator = getTranslatorApi();
  if (!Translator) return false;
  if (typeof Translator.availability !== "function") {
    // No availability probe; assume the API itself being present is enough.
    return true;
  }
  try {
    const status = await Translator.availability({
      sourceLanguage: "en",
      targetLanguage: "zh",
    });
    return status === "available" || status === "downloadable";
  } catch {
    return false;
  }
}
