import type {
  IncrementalMinutesSection,
  IncrementalTranscript,
  LLMMessage,
  SegmentDTO,
} from "@/lib/contracts";

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
 *   { sections: Array<{ title, timeStartMs?, timeEndMs?, narrative: string }>,
 *     summary: string }
 */
export function buildMinutesPrompt(input: BuildMinutesPromptInput): LLMMessage[] {
  const { segments, sourceLang, targetLang, styleHint } = input;

  const systemParts: string[] = [
    "You are a careful human note-taker writing readable meeting minutes for a colleague who missed the meeting and has 2-3 minutes to skim them.",
    `Source language of the transcript is ${sourceLang}. Write all minutes content in ${targetLang}.`,
    "Output STRICT JSON only, no preamble, no markdown fences, no commentary.",
    "Schema:",
    '{ "sections": [ { "title": string, "timeStartMs"?: number, "timeEndMs"?: number, "narrative": string } ], "summary": string }',
    "Rules:",
    "- Group the transcript into 3–8 coherent sections, in chronological order. A section title is a concise noun phrase in the target language (4-12 characters).",
    "- timeStartMs/timeEndMs should be the start of the first segment and end of the last segment that the section covers; omit them if you genuinely cannot tell.",
    "- `narrative` is the section body, written as 1-3 short paragraphs of running prose (NOT a bullet list, NOT dash-prefixed lines). Total length per section: roughly 150-400 characters in the target language.",
    "- Use complete sentences. Name the speakers when known (e.g. 'speaker 0 提出…'). Include concrete numbers, decisions, action items, dates, deadlines that actually appeared in the transcript.",
    "- Do NOT output markdown bullets, numbered lists, headings, or dashes inside `narrative`. Plain prose only. Paragraph breaks may use a literal newline character (\\n) inside the JSON string.",
    "- `summary` is a single paragraph (80–200 characters in the target language) capturing the meeting's outcome — what was decided, what's next.",
    "- Do not invent content. If something is unclear, omit it rather than guess. Skip filler ('好的', 'okay', 'uh').",
    "- Goal: the minutes should read like notes a thoughtful human colleague would jot down — informative, specific, prose-style.",
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
 * Build an INCREMENTAL minutes prompt — adds new bullets to a pending
 * section, decides whether the topic shifted. Mirrors lecsync's payload:
 *
 *   in: { confirmedSections, pendingSection?, newTranscripts }
 *   out: { topicChanged: boolean,
 *          currentTopic: { title, newPoints[], timeStartMs?, timeEndMs? } }
 *
 * The model sees:
 *   - The titles of already-confirmed sections (read-only memory)
 *   - The current pending section (title + existing points)
 *   - Only the NEW transcripts since the last refresh
 * and decides if those new transcripts continue the pending topic or open
 * a new one.
 */
export interface BuildIncrementalMinutesPromptInput {
  confirmedSections: IncrementalMinutesSection[];
  pendingSection: IncrementalMinutesSection | null;
  newTranscripts: IncrementalTranscript[];
  sourceLang: string;
  targetLang: string;
}

export function buildIncrementalMinutesPrompt(
  input: BuildIncrementalMinutesPromptInput
): LLMMessage[] {
  const { confirmedSections, pendingSection, newTranscripts, sourceLang, targetLang } = input;

  const system = [
    "You incrementally build readable meeting minutes from a live transcript.",
    `Transcript source language: ${sourceLang}. Write all minutes content in ${targetLang}.`,
    "Output STRICT JSON only — no preamble, no markdown fences, no commentary.",
    "Schema:",
    '{ "topicChanged": boolean,',
    '  "currentTopic": { "title": string, "newNarrative": string, "timeStartMs"?: number, "timeEndMs"?: number } }',
    "Rules:",
    "- You will receive: titles of confirmed sections (already locked), the pending section (current topic, may be null), and the NEW transcripts since the last update.",
    "- Decide if the new transcripts CONTINUE the pending topic or START a new one.",
    "  * If continuing: `topicChanged: false`, `currentTopic.title` = same as pending, `newNarrative` is ONLY the additional prose to APPEND to the running narrative (do not repeat existing content).",
    "  * If starting a new one: `topicChanged: true`, pick a fresh concise noun-phrase title (4-12 chars), `newNarrative` covers the new content from scratch.",
    "  * If pending is null (first update of the session): always `topicChanged: false`, treat the new transcripts as the first section.",
    "- `newNarrative` is plain running prose — complete sentences, no bullets, no dashes, no markdown. Roughly 50-200 characters in the target language per update. Mention speakers by id when meaningful.",
    "- Skip filler/greetings ('hello', '嗯', 'okay'). If the new transcripts contain only filler, return `newNarrative: \"\"`.",
    "- Do not invent content not present in the transcript. Stay grounded — concrete numbers, names, decisions only.",
    "- timeStartMs/timeEndMs are the bounds of the new transcripts you used; you may omit them.",
  ].join("\n");

  const confirmedTitles =
    confirmedSections.length > 0
      ? confirmedSections.map((s, i) => `[${i + 1}] ${s.title}`).join("\n")
      : "(none)";
  const pendingBody = pendingSection
    ? (pendingSection.narrative && pendingSection.narrative.trim()
        ? pendingSection.narrative.trim()
        : pendingSection.points.length
          ? pendingSection.points.map((p) => `- ${p}`).join("\n")
          : "(empty)")
    : null;
  const pendingBlock = pendingSection
    ? `Title: ${pendingSection.title}\nExisting narrative:\n${pendingBody}`
    : "(none — this is the first update of the session)";
  const transcriptBlock = newTranscripts
    .map((t) => `[${Math.floor(t.timestamp / 1000)}s] ${t.text}`)
    .join("\n");

  const user = [
    "## Confirmed section titles (locked, do not modify):",
    confirmedTitles,
    "",
    "## Pending section (current topic):",
    pendingBlock,
    "",
    "## New transcripts since last update:",
    transcriptBlock,
    "",
    "Output JSON only.",
  ].join("\n");

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
    "You are a careful human note-taker writing clean, readable markdown meeting minutes for someone who missed the meeting.",
    `Source language is ${sourceLang}. Write everything in ${targetLang}.`,
    "Output rules:",
    "- Use H2 (`## `) headings for each section. Choose 3–8 sections in chronological order.",
    "- Under each H2, write 1-3 short paragraphs of running prose (NOT bullets, NOT dashes). Each section body roughly 150-400 characters in the target language.",
    "- Use complete sentences. Include concrete numbers, decisions, action items, and speaker references where they actually appear in the transcript.",
    "- End the document with a final H2 titled `TL;DR` followed by a single short paragraph (80–200 characters).",
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
