import type { LLMMessage } from "@/lib/contracts";

export interface BuildChatSystemPromptInput {
  sessionTitle: string;
  sourceLang: string;
  targetLang: string;
  transcriptSnippet?: string;
}

/**
 * Compose the system prompt for the chat-about-a-recording feature. The
 * caller may include a recent transcript snippet so the model has context to
 * cite; this function does not truncate the snippet (the route is expected
 * to choose a window appropriate to its token budget).
 */
export function buildChatSystemPrompt(
  input: BuildChatSystemPromptInput
): string {
  const { sessionTitle, sourceLang, targetLang, transcriptSnippet } = input;

  const lines: string[] = [
    `You are a friendly assistant answering questions about a recording titled "${sessionTitle}".`,
    `The recording's source language is ${sourceLang}. Reply in ${targetLang} by default; if the user asks in another language, follow the user's language.`,
    "Use the transcript context below to ground your answers.",
    "When you quote, keep the quote short (under 30 words) and prefix it with the timestamp in [HH:MM:SS] form.",
    "If a question cannot be answered from the transcript, say so plainly — do not guess and do not invent quotes or timestamps.",
    "Keep answers concise. Use short lists or short paragraphs as appropriate.",
  ];

  if (transcriptSnippet && transcriptSnippet.trim().length > 0) {
    lines.push("");
    lines.push("Transcript context:");
    lines.push(transcriptSnippet.trim());
  } else {
    lines.push("");
    lines.push("Transcript context: (none available — say so if the user asks for specifics.)");
  }

  return lines.join("\n");
}

export interface BuildChatMessagesInput {
  system: string;
  history: LLMMessage[];
  userMessage: string;
}

/**
 * Convenience: build the final messages array for a chat turn.
 *   [system, ...history, {role:"user", content:userMessage}]
 */
export function buildChatMessages(
  input: BuildChatMessagesInput
): LLMMessage[] {
  const { system, history, userMessage } = input;
  return [
    { role: "system", content: system },
    ...history,
    { role: "user", content: userMessage },
  ];
}
