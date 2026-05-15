import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMGenerateOptions,
  LLMMessage,
  LLMProvider,
} from "@/lib/contracts";

const DEFAULT_MODEL = "claude-sonnet-4-6";

type AnthropicMessage = { role: "user" | "assistant"; content: string };

/**
 * Pull every `role: "system"` message off the message list, concatenate
 * them (newline-separated) into a single `system` string, and return the
 * remaining messages remapped into Anthropic's user/assistant shape.
 */
function splitMessages(messages: LLMMessage[], systemFallback?: string): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content && m.content.length > 0) systemParts.push(m.content);
      continue;
    }
    out.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content ?? "",
    });
  }
  if (systemParts.length === 0 && systemFallback && systemFallback.length > 0) {
    systemParts.push(systemFallback);
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export const claudeProvider: LLMProvider = {
  id: "claude",

  async generate(messages, options) {
    throwIfAborted(options?.signal);
    const modelName = options?.model ?? DEFAULT_MODEL;
    const maxTokens = options?.maxTokens ?? 4096;
    const { system, messages: mapped } = splitMessages(messages, options?.system);

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: modelName,
      max_tokens: maxTokens,
      temperature: options?.temperature,
      system,
      messages: mapped,
    });
    throwIfAborted(options?.signal);

    // The SDK returns a list of content blocks; concatenate text blocks.
    const parts: string[] = [];
    for (const block of response.content) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = block as any;
      if (b && b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("");
  },

  async *stream(messages, options) {
    throwIfAborted(options?.signal);
    const modelName = options?.model ?? DEFAULT_MODEL;
    const maxTokens = options?.maxTokens ?? 4096;
    const { system, messages: mapped } = splitMessages(messages, options?.system);

    const anthropic = getClient();
    const streamHandle = anthropic.messages.stream({
      model: modelName,
      max_tokens: maxTokens,
      temperature: options?.temperature,
      system,
      messages: mapped,
    });

    try {
      // The MessageStream is an async iterable of RawMessageStreamEvent.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const event of streamHandle as any) {
        throwIfAborted(options?.signal);
        if (!event || typeof event !== "object") continue;
        if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
            if (delta.text.length > 0) yield delta.text;
          }
        }
      }
    } finally {
      // Best-effort cleanup if the SDK exposes abort. Ignore errors.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const h: any = streamHandle;
        if (typeof h.abort === "function" && options?.signal?.aborted) h.abort();
      } catch {
        // ignore
      }
    }
  },
};
