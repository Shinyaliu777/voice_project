/**
 * Plain-text and Markdown decoder.
 *
 * Both `text/plain` and `text/markdown` route through here. We just decode
 * UTF-8 and return the raw text — no Markdown stripping, since the LLM term
 * extractor handles formatted text fine and we want quotable context.
 */
import type { ParseResult } from "./index";
import { assertWithinSizeCap, toNodeBuffer } from "./index";

export async function parsePlainText(
  input: Buffer | Uint8Array
): Promise<ParseResult> {
  assertWithinSizeCap(input, "plaintext");
  const buffer = toNodeBuffer(input);
  const text = buffer.toString("utf-8").trim();
  return { text };
}
