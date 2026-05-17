import type { LLMMessage } from "@/lib/contracts";

export interface BuildChatSystemPromptInput {
  /** Title of the bound recording, when one exists. */
  recordingTitle?: string | null;
  sourceLang?: string;
  targetLang?: string;
  transcriptSnippet?: string;
}

/**
 * Compose the system prompt for the chat feature.
 *
 * lecsync allows two distinct chat modes:
 *  1. "recording bound" — the chat is attached to a transcribed recording and
 *     the assistant should ground its answers in the transcript snippet.
 *  2. "no recording" — a generic helper chat (no transcript context). The
 *     assistant must NOT pretend a recording exists; the chat's own title is
 *     just a label for the conversation, not a recording.
 *
 * Older versions of this prompt always referred to a "recording titled X",
 * which caused the assistant to invent a recording even in no-recording chats
 * (e.g. "I understand you want to know about the recording named …" where X
 * was just the user-typed chat title). We branch on `recordingTitle` to fix
 * that.
 */
export function buildChatSystemPrompt(
  input: BuildChatSystemPromptInput
): string {
  const { recordingTitle, sourceLang, targetLang, transcriptSnippet } = input;
  const hasRecording =
    typeof recordingTitle === "string" && recordingTitle.trim().length > 0;

  const lines: string[] = [];

  if (hasRecording) {
    const src = sourceLang ?? "en";
    const tgt = targetLang ?? "en";
    lines.push(
      `You are a thoughtful assistant answering questions about a recording titled "${recordingTitle}".`,
      `The recording's source language is ${src}. Reply in ${tgt} by default; if the user asks in another language, follow the user's language.`,
      "Use the transcript context below to ground your answers. Be specific — cite content from the transcript by paraphrasing or quoting (under 30 words, prefixed with [HH:MM:SS]).",
      "Aim for genuinely useful, well-structured answers. Use Markdown — H2/H3 headings to organize multi-part responses, bold for key terms, numbered or bulleted lists for steps/items, code fences for code or commands.",
      "When the question is open-ended ('讲了什么 / 总结一下 / 这段录音有什么用'), produce a structured deep-dive: a short opening paragraph, then 3-5 headed sections each with 2-4 bullets, then a brief 总结. Don't be lazy — depth matters more than brevity for these.",
      "When the question is factual ('某某说了什么 / 时间是几点'), answer directly in one or two sentences.",
      "If a question cannot be answered from the transcript, say so plainly — do not guess and do not invent quotes or timestamps."
    );

    lines.push("");
    if (transcriptSnippet && transcriptSnippet.trim().length > 0) {
      lines.push("Transcript context:");
      lines.push(transcriptSnippet.trim());
    } else {
      lines.push(
        "Transcript context: (none available — say so if the user asks for specifics.)"
      );
    }
  } else {
    // Generic helper mode — no recording, no transcript. The user-typed chat
    // title (if any) is NOT a recording; treat the chat as a normal assistant.
    lines.push(
      "You are a thoughtful general-purpose assistant.",
      "There is no recording attached to this conversation, and the user is not asking about a transcript.",
      "Reply in the user's language. If they switch languages, follow them.",
      "Do not invent or refer to any recording, transcript, audio, video, or timestamps. The chat's title is just a label for this conversation — it is not the name of a recording.",
      "Aim for genuinely useful, well-structured answers. Use Markdown — H2/H3 headings to organize multi-part responses, bold for key terms, numbered or bulleted lists for steps/items, code fences for code or commands.",
      "For open-ended questions, produce a structured response with headings + grouped bullets, ending with a brief 总结 when helpful. Depth matters more than brevity.",
      "For simple factual questions, answer directly in one or two sentences — don't pad.",
      "If you genuinely don't know something, say so plainly instead of guessing."
    );
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
