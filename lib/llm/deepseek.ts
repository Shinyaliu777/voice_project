import type {
  LLMGenerateOptions,
  LLMMessage,
  LLMProvider,
} from "@/lib/contracts";

const DEFAULT_MODEL = "deepseek-chat";
const ENDPOINT = "https://api.deepseek.com/chat/completions";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Map our generic LLMMessage[] onto DeepSeek's chat format. If `system` is
 * supplied as a fallback and there's no leading system message already, we
 * prepend it.
 */
function buildMessages(
  messages: LLMMessage[],
  systemFallback?: string
): DeepSeekChatMessage[] {
  const out: DeepSeekChatMessage[] = [];
  const hasLeadingSystem = messages[0]?.role === "system";
  if (systemFallback && !hasLeadingSystem) {
    out.push({ role: "system", content: systemFallback });
  }
  for (const m of messages) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function buildBody(
  messages: LLMMessage[],
  options: LLMGenerateOptions | undefined,
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options?.model ?? DEFAULT_MODEL,
    messages: buildMessages(messages, options?.system),
    stream,
  };
  if (typeof options?.temperature === "number") body.temperature = options.temperature;
  if (typeof options?.maxTokens === "number") body.max_tokens = options.maxTokens;
  if (options?.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set. Get one at https://platform.deepseek.com/api_keys"
    );
  }
  return key;
}

interface DeepSeekChoice {
  message?: { content?: string };
}
interface DeepSeekResponse {
  choices?: DeepSeekChoice[];
  error?: { message?: string };
}

export const deepseekProvider: LLMProvider = {
  id: "deepseek",

  async generate(messages, options) {
    throwIfAborted(options?.signal);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify(buildBody(messages, options, false)),
      signal: options?.signal,
    });
    throwIfAborted(options?.signal);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`DeepSeek ${res.status}: ${txt.slice(0, 300)}`);
    }
    const data = (await res.json()) as DeepSeekResponse;
    if (data.error?.message) throw new Error(`DeepSeek: ${data.error.message}`);
    return data.choices?.[0]?.message?.content ?? "";
  },

  async *stream(messages, options) {
    throwIfAborted(options?.signal);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify(buildBody(messages, options, true)),
      signal: options?.signal,
    });
    if (!res.ok || !res.body) {
      const txt = res.body ? await res.text().catch(() => "") : "";
      throw new Error(`DeepSeek ${res.status}: ${txt.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      throwIfAborted(options?.signal);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        let parsed: { choices?: Array<{ delta?: { content?: string } }> };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta && delta.length > 0) yield delta;
      }
    }
  },
};
