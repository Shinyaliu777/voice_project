import type { TranslationProvider } from "@/lib/contracts";

/**
 * No-op translation: returns the source text unchanged. Used when the user
 * has translation turned off so the call sites can stay uniform.
 */
export const passthroughProvider: TranslationProvider = {
  id: "passthrough",
  async translate(req) {
    return {
      translatedText: req.text,
      translationSource: "passthrough",
    };
  },
};
