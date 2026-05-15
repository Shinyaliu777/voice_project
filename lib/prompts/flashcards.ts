import type { LLMMessage, SegmentDTO } from "@/lib/contracts";

export interface BuildFlashcardCandidatesPromptInput {
  segments: SegmentDTO[];
  targetLanguage: string;
  maxCards: number;
}

const MAX_USER_CHARS = 30_000;

/**
 * Serialize segments. Mirrors the format used by `minutes.ts` so the model
 * can refer to segment ids when grounding a card.
 */
function serializeSegments(segments: SegmentDTO[]): string {
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const speaker = s.speakerId != null ? `(speaker ${s.speakerId})` : "(speaker ?)";
    const time = `[${s.audioStartMs}-${s.audioEndMs}]`;
    const src = (s.sourceText ?? "").replace(/\s+/g, " ").trim();
    const tgt = (s.translatedText ?? "").replace(/\s+/g, " ").trim();
    // Prefix with the canonical segment id so the model can echo it as
    // `sourceSegmentId`.
    lines.push(`[#${i}] id=${s.id} ${speaker} ${time} ${src} | ${tgt}`);
  }
  return lines.join("\n");
}

function truncateFromMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n…[transcript truncated from the middle for length]…\n";
  const keep = Math.max(0, maxChars - marker.length);
  const half = Math.floor(keep / 2);
  return text.slice(0, half) + marker + text.slice(text.length - (keep - half));
}

/**
 * Build a JSON-output prompt for study flashcard candidates. Shape:
 *   { cards: Array<{ front, back, sourceSegmentId? }> }
 */
export function buildFlashcardCandidatesPrompt(
  input: BuildFlashcardCandidatesPromptInput
): LLMMessage[] {
  const { segments, targetLanguage, maxCards } = input;
  const cap = Math.max(1, Math.min(100, Math.floor(maxCards)));

  const system = [
    "You build study flashcards from a lecture or meeting transcript.",
    `Write the cards in ${targetLanguage}.`,
    "Each card must test a non-trivial term, concept, fact, or relationship from the transcript.",
    "Avoid trivia, throwaway phrasing, filler, or anything not in the transcript.",
    "Output STRICT JSON only, no preamble, no markdown fences, no commentary.",
    "Schema:",
    '{ "cards": [ { "front": string, "back": string, "sourceSegmentId"?: string } ] }',
    "Rules:",
    `- Produce up to ${cap} cards. Fewer is fine if the transcript is short.`,
    "- `front` is a short question or a term (one short sentence or a noun phrase).",
    "- `back` is the answer, followed by ONE short clarifying sentence (total under 200 characters).",
    "- When a card is grounded in a specific segment, include its `id` as `sourceSegmentId`. Omit the field if you are unsure.",
    "- Deduplicate; merge near-duplicates into the better card.",
    "- Skip cards that are answerable without the transcript.",
  ].join("\n");

  const body = truncateFromMiddle(serializeSegments(segments), MAX_USER_CHARS);
  const user = `Transcript segments (one per line):\n${body}\n\nOutput JSON only.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
