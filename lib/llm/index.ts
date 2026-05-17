import type { LLMProvider } from "@/lib/contracts";
import { geminiProvider } from "./gemini";
import { claudeProvider } from "./claude";
import { deepseekProvider } from "./deepseek";

export type LLMProviderName = "gemini" | "claude" | "deepseek";

const cache = new Map<LLMProviderName, LLMProvider>();

function resolveDefault(): LLMProviderName {
  const raw = (process.env.LLM_DEFAULT_PROVIDER ?? "gemini").trim().toLowerCase();
  if (raw === "claude") return "claude";
  if (raw === "deepseek") return "deepseek";
  return "gemini";
}

/**
 * Return the cached LLMProvider for the given name, falling back to the
 * `LLM_DEFAULT_PROVIDER` env var (then to "gemini").
 */
export function getLLMProvider(name?: LLMProviderName): LLMProvider {
  const key: LLMProviderName = name ?? resolveDefault();
  const cached = cache.get(key);
  if (cached) return cached;
  const impl =
    key === "claude"
      ? claudeProvider
      : key === "deepseek"
        ? deepseekProvider
        : geminiProvider;
  cache.set(key, impl);
  return impl;
}

export { geminiProvider, claudeProvider, deepseekProvider };
