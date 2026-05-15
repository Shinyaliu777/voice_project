import type { LLMMessage } from "@/lib/contracts";

export interface BuildTranslatePromptInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  terms?: Array<{ term: string; definition?: string }>;
}

/**
 * Compose messages for a single-shot translation call.
 * The model is asked to produce ONLY the translated string — no notes, no
 * prefixes, no quote marks. Glossary entries are passed as a small block so
 * the translator can honor user-specific terminology.
 */
export function buildTranslatePrompt(
  input: BuildTranslatePromptInput
): LLMMessage[] {
  const { text, sourceLanguage, targetLanguage, terms } = input;

  const system =
    "You are a professional translator. " +
    "Translate the user's text from the given source language into the given target language. " +
    "Honor the glossary if provided: when a glossary term appears in the source, render it consistently with the glossary entry; if a definition is given, treat it as the intended meaning. " +
    "Preserve original formatting, punctuation, casing of proper nouns, and line breaks. " +
    "Do not add notes, transliterations, parentheses with the source word, headings, or any meta-comment. " +
    "Output the translated text only.";

  const glossaryLines: string[] = [];
  if (terms && terms.length > 0) {
    glossaryLines.push("Glossary:");
    for (const t of terms) {
      const def = t.definition?.trim();
      glossaryLines.push(`- ${t.term} = ${def && def.length > 0 ? def : "(use as-is)"}`);
    }
    glossaryLines.push("");
  }

  const userParts: string[] = [];
  if (glossaryLines.length > 0) userParts.push(glossaryLines.join("\n"));
  userParts.push(
    `Translate the following from ${sourceLanguage} to ${targetLanguage}:`
  );
  userParts.push(text);

  return [
    { role: "system", content: system },
    { role: "user", content: userParts.join("\n") },
  ];
}
