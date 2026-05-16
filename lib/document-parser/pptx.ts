/**
 * PPTX text extraction backed by `officeparser`.
 *
 * `parseOfficeAsync` accepts a Buffer or ArrayBuffer and returns the
 * concatenated text of every slide, separated by the configured newline
 * delimiter. We include speaker notes by default (the LLM downstream can
 * mine extra terminology from them).
 */
import { parseOfficeAsync } from "officeparser";
import type { ParseResult } from "./index";
import { assertWithinSizeCap, toNodeBuffer } from "./index";

export async function parsePptx(
  input: Buffer | Uint8Array
): Promise<ParseResult> {
  assertWithinSizeCap(input, "PPTX");
  const buffer = toNodeBuffer(input);

  const raw = await parseOfficeAsync(buffer, {
    newlineDelimiter: "\n",
    ignoreNotes: false,
  });
  const text = typeof raw === "string" ? raw.trim() : "";
  return { text };
}
