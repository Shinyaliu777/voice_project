/**
 * Document parser dispatcher.
 *
 * `getDocumentParser(fileType)` returns the appropriate parser for a given
 * MIME type or filename extension. `parseDocument(...)` is the one-call
 * convenience used by the extract-terms route — it picks the parser and
 * runs it in one step.
 *
 * Every parser accepts either a Node `Buffer` or a `Uint8Array`. All parsers
 * enforce a 20 MB size cap and throw on oversized inputs so the API surface
 * can fail fast instead of blowing past memory limits.
 */
import { parsePdf } from "./pdf";
import { parseDocx } from "./docx";
import { parsePptx } from "./pptx";
import { parsePlainText } from "./plaintext";

export interface ParseResult {
  text: string;
  pages?: number;
}

export interface DocumentParser {
  parse(
    buffer: Buffer | Uint8Array,
    fileType: string,
    fileName: string
  ): Promise<ParseResult>;
}

export type ParserKind = "pdf" | "docx" | "pptx" | "plaintext";

export const MAX_PARSE_BYTES = 20 * 1024 * 1024; // 20 MB

const MIME_TO_KIND: Record<string, ParserKind> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "plaintext",
  "text/markdown": "plaintext",
  "text/x-markdown": "plaintext",
};

const EXT_TO_KIND: Record<string, ParserKind> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  txt: "plaintext",
  md: "plaintext",
  markdown: "plaintext",
};

function extOf(fileName: string): string {
  if (!fileName) return "";
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Pick a parser kind for a (fileType, fileName) pair. MIME match wins; if
 * that fails we fall back to the filename extension. Returns null when
 * nothing matches so callers can throw a descriptive error.
 */
export function detectParserKind(
  fileType: string,
  fileName?: string
): ParserKind | null {
  const mime = (fileType ?? "").trim().toLowerCase();
  if (mime && MIME_TO_KIND[mime]) return MIME_TO_KIND[mime];

  if (fileName) {
    const ext = extOf(fileName);
    if (ext && EXT_TO_KIND[ext]) return EXT_TO_KIND[ext];
  }

  // Last resort: try to read an extension out of the "fileType" string itself
  // in case a caller passed ".pdf" or "pdf" instead of a real MIME.
  const fallbackExt = mime.replace(/^\.+/, "");
  if (fallbackExt && EXT_TO_KIND[fallbackExt]) return EXT_TO_KIND[fallbackExt];

  return null;
}

class PdfParser implements DocumentParser {
  async parse(
    buffer: Buffer | Uint8Array,
    _fileType: string,
    _fileName: string
  ): Promise<ParseResult> {
    return parsePdf(buffer);
  }
}

class DocxParser implements DocumentParser {
  async parse(
    buffer: Buffer | Uint8Array,
    _fileType: string,
    _fileName: string
  ): Promise<ParseResult> {
    return parseDocx(buffer);
  }
}

class PptxParser implements DocumentParser {
  async parse(
    buffer: Buffer | Uint8Array,
    _fileType: string,
    _fileName: string
  ): Promise<ParseResult> {
    return parsePptx(buffer);
  }
}

class PlainTextParser implements DocumentParser {
  async parse(
    buffer: Buffer | Uint8Array,
    _fileType: string,
    _fileName: string
  ): Promise<ParseResult> {
    return parsePlainText(buffer);
  }
}

/**
 * Get a parser for the given file type. Throws when the type is unsupported.
 */
export function getDocumentParser(
  fileType: string,
  fileName?: string
): DocumentParser {
  const kind = detectParserKind(fileType, fileName);
  switch (kind) {
    case "pdf":
      return new PdfParser();
    case "docx":
      return new DocxParser();
    case "pptx":
      return new PptxParser();
    case "plaintext":
      return new PlainTextParser();
    default:
      throw new Error(
        `Unsupported document type: ${fileType || "(unknown)"}${
          fileName ? ` (file: ${fileName})` : ""
        }`
      );
  }
}

/**
 * One-shot helper: detect parser, run it, return `{ text, pages? }`.
 */
export async function parseDocument(
  buffer: Buffer | Uint8Array,
  fileType: string,
  fileName: string
): Promise<ParseResult> {
  const parser = getDocumentParser(fileType, fileName);
  return parser.parse(buffer, fileType, fileName);
}

/**
 * Coerce a `Buffer | Uint8Array` to a real Node Buffer without copying when
 * possible. Shared by all parser implementations.
 */
export function toNodeBuffer(input: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(input)) return input;
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

/**
 * Enforce the per-parse size cap. Throws a clear error so the route can
 * mark the document as failed and surface a useful message.
 */
export function assertWithinSizeCap(
  buffer: Buffer | Uint8Array,
  label: string
): void {
  if (buffer.byteLength > MAX_PARSE_BYTES) {
    throw new Error(
      `${label} parse aborted: file is ${buffer.byteLength} bytes which exceeds the ${MAX_PARSE_BYTES}-byte limit`
    );
  }
}
