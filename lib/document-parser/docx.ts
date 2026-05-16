/**
 * DOCX text extraction backed by `mammoth`.
 *
 * `mammoth.extractRawText` returns paragraph-separated plain text with no
 * formatting — exactly what we want for downstream term extraction.
 */
import mammoth from "mammoth";
import type { ParseResult } from "./index";
import { assertWithinSizeCap, toNodeBuffer } from "./index";

export async function parseDocx(
  input: Buffer | Uint8Array
): Promise<ParseResult> {
  assertWithinSizeCap(input, "DOCX");
  const buffer = toNodeBuffer(input);

  const result = await mammoth.extractRawText({ buffer });
  const text = typeof result?.value === "string" ? result.value.trim() : "";
  return { text };
}
