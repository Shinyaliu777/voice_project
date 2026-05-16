/**
 * PDF text extraction backed by `pdf-parse`.
 *
 * Note: `pdf-parse@1.x` historically tried to require a debug test fixture
 * at module load when `module.parent` was null, which can break serverless
 * runtimes that don't populate `module.parent`. To dodge that we import the
 * implementation file directly (`pdf-parse/lib/pdf-parse.js`) rather than
 * the package root. The community DefinitelyTyped typings only cover the
 * package root, so we re-state the minimal subpath types locally.
 */
import type { ParseResult } from "./index";
import { assertWithinSizeCap, toNodeBuffer } from "./index";

// Local ambient declaration for the pdf-parse subpath import.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    version: string;
    text: string;
  }
  function pdfParse(
    dataBuffer: Buffer,
    options?: Record<string, unknown>
  ): Promise<PdfParseResult>;
  export = pdfParse;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export async function parsePdf(
  input: Buffer | Uint8Array
): Promise<ParseResult> {
  assertWithinSizeCap(input, "PDF");
  const buffer = toNodeBuffer(input);

  const result = await pdfParse(buffer);
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  const pages =
    typeof result?.numpages === "number" && Number.isFinite(result.numpages)
      ? result.numpages
      : undefined;

  return { text, pages };
}
