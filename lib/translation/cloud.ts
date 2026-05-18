import type {
  TranslationProvider,
  TranslationResponse,
} from "@/lib/contracts";
import { getLLMProvider } from "@/lib/llm";
import { buildTranslatePrompt } from "@/lib/prompts/translate";

/**
 * Server-side translation that fans out to whatever LLM is configured by
 * `LLM_DEFAULT_PROVIDER` (gemini / claude / deepseek). The translation
 * pipeline used to hard-code Gemini here, which masked LLM_DEFAULT_PROVIDER
 * for everything except translation and was the cause of "I switched to
 * DeepSeek but I'm still hitting Gemini quotas" on prod.
 *
 * The LLM provider is loaded lazily inside `translate` so that constructing
 * the provider does not run at module import time (keeps cold-starts fast
 * and avoids touching env vars before they are read).
 */
export const cloudTranslationProvider: TranslationProvider = {
  id: "cloud",
  async translate(req) {
    const messages = buildTranslatePrompt({
      text: req.text,
      sourceLanguage: req.sourceLanguage,
      targetLanguage: req.targetLanguage,
      terms: req.terms,
    });
    const llm = getLLMProvider();
    const out = await llm.generate(messages, {
      temperature: 0.2,
      responseFormat: "text",
    });
    return {
      translatedText: out.trim(),
      translationSource: llm.id as TranslationResponse["translationSource"],
    };
  },
};
