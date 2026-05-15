import type { LLMMessage } from "@/lib/contracts";

export interface BuildTermExtractPromptInput {
  documentText: string;
  language?: string;
}

const MAX_USER_CHARS = 30_000;

/**
 * Truncate a document while preserving head and tail. A short marker is
 * inserted at the cut so the model knows content was elided.
 */
function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = "\n…[document truncated for length]…\n";
  const keep = Math.max(0, maxChars - marker.length);
  const half = Math.floor(keep / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - (keep - half));
  return { text: head + marker + tail, truncated: true };
}

/**
 * Build a JSON-output prompt that asks the model to extract domain
 * terminology and named entities from a reference document. Shape:
 *   { terms: Array<{ term: string, definition?: string }> }
 */
export function buildTermExtractPrompt(
  input: BuildTermExtractPromptInput
): LLMMessage[] {
  const { documentText, language } = input;

  const systemParts: string[] = [
    "You are a terminology extractor.",
    "Extract domain-specific terminology, named entities, jargon, and abbreviations from the document the user provides.",
    "Output STRICT JSON only, no preamble, no markdown fences, no commentary.",
    "Schema:",
    '{ "terms": [ { "term": string, "definition"?: string } ] }',
    "Rules:",
    "- Return at most 50 of the most useful terms.",
    "- Skip stopwords, common words, generic concepts, and obvious phrases.",
    "- Prefer multi-word terms over single words when both refer to the same concept.",
    "- A `definition` is a short clarifying gloss (under 120 characters) — include it only when it is reasonably inferable from the document.",
    "- Deduplicate case-insensitively; pick the form that appears most naturally.",
    "- Keep the original capitalization of proper nouns and abbreviations.",
  ];
  if (language && language.trim().length > 0) {
    systemParts.push(
      `Definitions, if you include them, should be written in ${language}.`
    );
  }
  const system = systemParts.join("\n");

  const truncated = truncate(documentText, MAX_USER_CHARS);
  const user =
    `Document:\n${truncated.text}` +
    (truncated.truncated
      ? "\n\nNote: the document was truncated for length."
      : "") +
    "\n\nOutput JSON only.";

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
