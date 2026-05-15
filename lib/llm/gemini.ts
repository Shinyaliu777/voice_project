import {
  GoogleGenerativeAI,
  type Content,
  type GenerationConfig,
} from "@google/generative-ai";
import type {
  LLMGenerateOptions,
  LLMMessage,
  LLMProvider,
} from "@/lib/contracts";

const DEFAULT_MODEL = "gemini-2.0-flash";

/**
 * Pull every `role: "system"` message off the front-or-mixed message list,
 * concatenate them (newline-separated) into a single systemInstruction
 * string, and return the remaining messages remapped into Gemini's
 * `Content[]` shape with role "user" or "model".
 */
function splitMessages(messages: LLMMessage[], systemFallback?: string): {
  systemInstruction?: string;
  contents: Content[];
} {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content && m.content.length > 0) systemParts.push(m.content);
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: m.content ?? "" }] });
  }
  if (systemParts.length === 0 && systemFallback && systemFallback.length > 0) {
    systemParts.push(systemFallback);
  }
  return {
    systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    contents,
  };
}

function buildGenerationConfig(
  options?: LLMGenerateOptions
): GenerationConfig | undefined {
  if (!options) return undefined;
  const cfg: GenerationConfig = {};
  if (typeof options.temperature === "number") cfg.temperature = options.temperature;
  if (typeof options.maxTokens === "number") cfg.maxOutputTokens = options.maxTokens;
  if (options.responseFormat === "json") cfg.responseMimeType = "application/json";
  if (Object.keys(cfg).length === 0) return undefined;
  return cfg;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

let cachedClient: GoogleGenerativeAI | null = null;
function getClient(): GoogleGenerativeAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  cachedClient = new GoogleGenerativeAI(apiKey);
  return cachedClient;
}

export const geminiProvider: LLMProvider = {
  id: "gemini",

  async generate(messages, options) {
    throwIfAborted(options?.signal);
    const modelName = options?.model ?? DEFAULT_MODEL;
    const { systemInstruction, contents } = splitMessages(messages, options?.system);
    const generationConfig = buildGenerationConfig(options);

    const client = getClient();
    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction,
      generationConfig,
    });

    const result = await model.generateContent({ contents });
    throwIfAborted(options?.signal);
    return result.response.text();
  },

  async *stream(messages, options) {
    throwIfAborted(options?.signal);
    const modelName = options?.model ?? DEFAULT_MODEL;
    const { systemInstruction, contents } = splitMessages(messages, options?.system);
    const generationConfig = buildGenerationConfig(options);

    const client = getClient();
    const model = client.getGenerativeModel({
      model: modelName,
      systemInstruction,
      generationConfig,
    });

    const result = await model.generateContentStream({ contents });
    for await (const chunk of result.stream) {
      throwIfAborted(options?.signal);
      const text = chunk.text();
      if (text && text.length > 0) yield text;
    }
  },
};
