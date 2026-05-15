import type { LLMMessage, SegmentDTO } from "@/lib/contracts";

export interface BuildMinutesPromptInput {
  segments: SegmentDTO[];
  sourceLang: string;
  targetLang: string;
  styleHint?: string;
}

const MAX_USER_CHARS = 30_000;

/**
 * Serialize segments into the canonical line format used across all prompts
 * that consume a transcript. Format:
 *   [#i] (speaker N) [startMs-endMs] sourceText | translatedText
 */
function serializeSegments(segments: SegmentDTO[]): string {
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const speaker = s.speakerId != null ? `(speaker ${s.speakerId})` : "(speaker ?)";
    const time = `[${s.audioStartMs}-${s.audioEndMs}]`;
    const src = (s.sourceText ?? "").replace(/\s+/g, " ").trim();
    const tgt = (s.translatedText ?? "").replace(/\s+/g, " ").trim();
    lines.push(`[#${i}] ${speaker} ${time} ${src} | ${tgt}`);
  }
  return lines.join("\n");
}

/**
 * Truncate a large transcript by removing characters from the middle so the
 * head and tail (which usually contain the framing of a meeting) survive.
 * A short marker is inserted at the cut.
 */
function truncateFromMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n…[transcript truncated from the middle for length]…\n";
  const keep = Math.max(0, maxChars - marker.length);
  const half = Math.floor(keep / 2);
  return text.slice(0, half) + marker + text.slice(text.length - (keep - half));
}

/**
 * Build a JSON-output prompt for structured minutes. Shape:
 *   { sections: Array<{ title, timeStartMs?, timeEndMs?, points: string[] }>,
 *     summary: string }
 */
export function buildMinutesPrompt(input: BuildMinutesPromptInput): LLMMessage[] {
  const { segments, sourceLang, targetLang, styleHint } = input;

  const systemParts: string[] = [
    "You are an assistant that turns a meeting transcript into structured, useful minutes for someone who missed the meeting.",
    `Source language of the transcript is ${sourceLang}. Write all minutes content in ${targetLang}.`,
    "Output STRICT JSON only, no preamble, no markdown fences, no commentary.",
    "Schema:",
    '{ "sections": [ { "title": string, "timeStartMs"?: number, "timeEndMs"?: number, "points": string[] } ], "summary": string }',
    "Rules:",
    "- Group the transcript into 3–8 coherent sections. A section title is a concise noun phrase in the target language.",
    "- timeStartMs/timeEndMs should be the start of the first segment and end of the last segment that the section covers; omit them if you genuinely cannot tell.",
    "- Each `points` array contains 2–6 bullet points. Each point is concise — aim for 8–20 characters in the target language. No leading dashes, no trailing punctuation if not needed.",
    "- `summary` is a single paragraph (40–120 chars in the target language) capturing what the meeting decided / accomplished.",
    "- Do not invent content not present in the transcript. If something is unclear, omit it instead of guessing.",
    "- Goal: the minutes should be useful to a reader who missed the meeting and only has 60 seconds.",
  ];
  if (styleHint && styleHint.trim().length > 0) {
    systemParts.push(`Style hint from the user: ${styleHint.trim()}`);
  }
  const system = systemParts.join("\n");

  const body = truncateFromMiddle(serializeSegments(segments), MAX_USER_CHARS);
  const user = `Transcript segments (one per line):\n${body}\n\nOutput JSON only.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * Build a markdown-output prompt for the same minutes. Used when we want
 * something we can render directly without a JSON schema.
 */
export function buildMinutesMarkdownPrompt(
  input: BuildMinutesPromptInput
): LLMMessage[] {
  const { segments, sourceLang, targetLang, styleHint } = input;

  const systemParts: string[] = [
    "You are an assistant that turns a meeting transcript into clean, readable markdown minutes for someone who missed the meeting.",
    `Source language is ${sourceLang}. Write everything in ${targetLang}.`,
    "Output rules:",
    "- Use H2 (`## `) headings for each section. Choose 3–8 sections.",
    "- Under each H2, use bullet points (`- `) for the key takeaways. Keep each bullet concise (8–20 characters in the target language).",
    "- End the document with a final H2 titled `TL;DR` followed by a single short paragraph (40–120 characters).",
    "- Do not include any meta commentary, code fences, or JSON. Output the markdown body only.",
    "- Do not invent content; omit anything that is unclear in the transcript.",
  ];
  if (styleHint && styleHint.trim().length > 0) {
    systemParts.push(`Style hint from the user: ${styleHint.trim()}`);
  }
  const system = systemParts.join("\n");

  const body = truncateFromMiddle(serializeSegments(segments), MAX_USER_CHARS);
  const user = `Transcript segments (one per line):\n${body}\n\nWrite the markdown minutes now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
