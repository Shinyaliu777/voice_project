import type { LLMProvider } from "@/lib/contracts";
import { geminiProvider } from "./gemini";
import { claudeProvider } from "./claude";

export type LLMProviderName = "gemini" | "claude";

const cache = new Map<LLMProviderName, LLMProvider>();

function resolveDefault(): LLMProviderName {
  const raw = (process.env.LLM_DEFAULT_PROVIDER ?? "gemini").trim().toLowerCase();
  return raw === "claude" ? "claude" : "gemini";
}

/**
 * Return the cached LLMProvider for the given name, falling back to the
 * `LLM_DEFAULT_PROVIDER` env var (then to "gemini").
 */
export function getLLMProvider(name?: LLMProviderName): LLMProvider {
  const key: LLMProviderName = name ?? resolveDefault();
  const cached = cache.get(key);
  if (cached) return cached;
  const impl = key === "claude" ? claudeProvider : geminiProvider;
  cache.set(key, impl);
  return impl;
}

export { geminiProvider, claudeProvider };
