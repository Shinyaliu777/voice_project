import type { TranslationProvider } from "@/lib/contracts";
import { getLLMProvider } from "@/lib/llm";
import { buildTranslatePrompt } from "@/lib/prompts/translate";

/**
 * Server-side translation that fans out to the Gemini LLM. Uses the shared
 * `lib/prompts/translate.ts` composer so prompt tweaks live in one place.
 *
 * The LLM provider is loaded lazily inside `translate` so that constructing
 * the provider does not run at module import time (keeps cold-starts fast
 * and avoids touching env vars before they are read).
 */
export const geminiTranslationProvider: TranslationProvider = {
  id: "gemini",
  async translate(req) {
    const messages = buildTranslatePrompt({
      text: req.text,
      sourceLanguage: req.sourceLanguage,
      targetLanguage: req.targetLanguage,
      terms: req.terms,
    });
    const llm = getLLMProvider("gemini");
    const out = await llm.generate(messages, {
      temperature: 0.2,
      responseFormat: "text",
    });
    return {
      translatedText: out.trim(),
      translationSource: "gemini",
    };
  },
};
