import type { TranslationProvider } from "@/lib/contracts";
import { passthroughProvider } from "./passthrough";
import { cloudTranslationProvider } from "./cloud";
import { chromeLocalProvider, isChromeTranslatorAvailable } from "./chrome-local";

export type ServerTranslationMode = "off" | "cloud";
export type ClientTranslationMode = "off" | "local" | "cloud";

/**
 * Server-side factory. The server only ever does passthrough or routes the
 * call to its cloud LLM; it never talks to Chrome's local Translator API.
 */
export function getServerTranslationProvider(
  mode: ServerTranslationMode
): TranslationProvider {
  if (mode === "off") return passthroughProvider;
  return cloudTranslationProvider;
}

/**
 * Thin proxy used by the browser when the user picks "cloud" translation:
 * POSTs to our own `/api/translate` route so the API key never leaves the
 * server. The server route picks whichever LLM `LLM_DEFAULT_PROVIDER`
 * points at — the response payload carries the real `translationSource`
 * for UI badges, we just label this proxy generically.
 */
export const cloudProxyProvider: TranslationProvider = {
  id: "cloud",
  async translate(req) {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`/api/translate ${res.status}`);
    return await res.json();
  },
};

/**
 * Browser-side factory. "local" uses Chrome's on-device Translator API,
 * "cloud" goes through the server, and "off" is passthrough.
 */
export function getClientTranslationProvider(
  mode: ClientTranslationMode
): TranslationProvider {
  switch (mode) {
    case "off":
      return passthroughProvider;
    case "local":
      return chromeLocalProvider;
    case "cloud":
      return cloudProxyProvider;
  }
}

export {
  passthroughProvider,
  cloudTranslationProvider,
  chromeLocalProvider,
  isChromeTranslatorAvailable,
};
