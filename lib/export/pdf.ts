/**
 * PDF (.pdf) export for a session.
 *
 * Composition layer over the `pdfkit` library. Mirrors the layout used by
 * `lib/export/word.ts`:
 *   1. Title block (H1 + small meta line)
 *   2. AI Minutes — markdown (preferred) or section objects (fallback)
 *   3. Transcript — one block per segment with speaker / timestamp /
 *      source text / translated text in italic
 *
 * The bundled PDF Standard Type-1 fonts can't render CJK glyphs, so we
 * register Noto Sans SC (Simplified Chinese) once and use it for every text
 * run. The font file ships under `public/fonts/` so this code does no
 * network IO at request time.
 *
 * Returns a Buffer ready to be sent as the response body.
 *
 * Server-only. Do not import from a "use client" module.
 */
import PDFDocument from "pdfkit";
import path from "node:path";
import fs from "node:fs";
import type { Session, SpeakerName } from "@prisma/client";
import type { MinutesDTO, MinutesSection, SegmentDTO } from "@/lib/contracts";

// --------- public API ---------

export interface SessionLite
  extends Pick<
    Session,
    | "id"
    | "title"
    | "sourceLang"
    | "targetLang"
    | "durationMs"
    | "createdAt"
  > {}

const CJK_FONT_FILENAME = "NotoSansSC-Regular.ttf";
const CJK_FONT_PATH = path.join(
  process.cwd(),
  "public",
  "fonts",
  CJK_FONT_FILENAME
);
const CJK_FONT_KEY = "CJK";

const PAGE_MARGIN = 50;
const FONT_SIZE_BODY = 12;
const FONT_SIZE_META = 10;
const FONT_SIZE_H1 = 18;
const FONT_SIZE_H2 = 14;
const FONT_SIZE_H3 = 12;
const FONT_SIZE_SMALL = 9;

const COLOR_TEXT = "#1f1f1f";
const COLOR_MUTED = "#555555";
const COLOR_PLACEHOLDER = "#888888";

/** Thrown when the CJK font file is missing — caller should return 503. */
export class PdfFontUnavailableError extends Error {
  fontPath: string;
  constructor(fontPath: string) {
    super(
      `CJK font file not found at ${fontPath}. ` +
        `Download Noto Sans SC and place it at public/fonts/${CJK_FONT_FILENAME}.`
    );
    this.name = "PdfFontUnavailableError";
    this.fontPath = fontPath;
  }
}

export async function generateSessionPdf(
  session: SessionLite,
  segments: SegmentDTO[],
  speakerNames: SpeakerName[],
  minutes: MinutesDTO | null
): Promise<Buffer> {
  if (!fs.existsSync(CJK_FONT_PATH)) {
    throw new PdfFontUnavailableError(CJK_FONT_PATH);
  }

  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    info: {
      Title: (session.title ?? "").trim() || "未命名会话",
      Creator: "Voice Project",
    },
  });

  doc.registerFont(CJK_FONT_KEY, CJK_FONT_PATH);
  doc.font(CJK_FONT_KEY);

  // --- Title block
  const niceTitle = (session.title ?? "").trim() || "未命名会话";
  doc
    .fontSize(FONT_SIZE_H1)
    .fillColor(COLOR_TEXT)
    .text(niceTitle, { align: "left" });
  doc.moveDown(0.25);
  doc
    .fontSize(FONT_SIZE_META)
    .fillColor(COLOR_MUTED)
    .text(buildMetaLine(session));
  doc.moveDown(0.75);

  // --- Minutes section
  renderSectionHeading(doc, "纪要 (AI Minutes)");
  if (minutes && minutes.contentMd && minutes.contentMd.trim().length > 0) {
    renderMarkdown(doc, minutes.contentMd);
  } else if (minutes && minutes.sections && minutes.sections.length > 0) {
    renderSections(doc, minutes.sections);
  } else {
    doc
      .fontSize(FONT_SIZE_BODY)
      .fillColor(COLOR_PLACEHOLDER)
      .text("暂无纪要。", { oblique: true });
    doc.moveDown(0.5);
  }

  // --- Transcript section
  renderSectionHeading(doc, "转录 (Transcript)");
  if (segments.length === 0) {
    doc
      .fontSize(FONT_SIZE_BODY)
      .fillColor(COLOR_PLACEHOLDER)
      .text("暂无转录内容。", { oblique: true });
  } else {
    const speakerNameById = mapSpeakerNames(speakerNames);
    for (const seg of segments) {
      renderSegmentBlock(doc, seg, speakerNameById);
    }
  }

  return await finalize(doc);
}

// --------- internal helpers ---------

function finalize(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function renderSectionHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.75);
  doc
    .fontSize(FONT_SIZE_H2)
    .fillColor(COLOR_TEXT)
    .text(text);
  doc.moveDown(0.3);
}

function buildMetaLine(s: SessionLite): string {
  const parts: string[] = [];
  parts.push(`${s.sourceLang} → ${s.targetLang}`);
  if (typeof s.durationMs === "number" && s.durationMs > 0) {
    parts.push(formatDuration(s.durationMs));
  }
  if (s.createdAt) {
    parts.push(formatDate(s.createdAt));
  }
  return parts.join("  ·  ");
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function mapSpeakerNames(rows: SpeakerName[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of rows) out.set(r.speakerId, r.name);
  return out;
}

function speakerLabel(
  speakerId: number | null,
  byId: Map<number, string>
): string {
  if (speakerId == null) return "说话人";
  return byId.get(speakerId) ?? `说话人 ${speakerId}`;
}

function renderSegmentBlock(
  doc: PDFKit.PDFDocument,
  seg: SegmentDTO,
  speakerById: Map<number, string>
): void {
  const stamp = formatDuration(seg.audioStartMs);
  const speaker = speakerLabel(seg.speakerId, speakerById);

  doc.moveDown(0.4);
  // Header line: bold-style speaker label + grey timestamp.
  // pdfkit can't toggle bold without a separate bold font, so we use
  // a slightly larger size for the speaker name to give visual weight.
  doc
    .fontSize(FONT_SIZE_BODY)
    .fillColor(COLOR_TEXT)
    .text(speaker, { continued: true })
    .fillColor(COLOR_MUTED)
    .fontSize(FONT_SIZE_SMALL)
    .text(`   ${stamp}`);

  doc
    .fontSize(FONT_SIZE_BODY)
    .fillColor(COLOR_TEXT)
    .text(seg.sourceText.trim());

  if (seg.translatedText && seg.translatedText.trim().length > 0) {
    doc
      .fontSize(FONT_SIZE_BODY)
      .fillColor(COLOR_MUTED)
      .text(seg.translatedText.trim(), { oblique: true });
  }
}

function renderSections(
  doc: PDFKit.PDFDocument,
  sections: MinutesSection[]
): void {
  for (const s of sections) {
    const range =
      typeof s.timeStartMs === "number" && typeof s.timeEndMs === "number"
        ? ` (${formatDuration(s.timeStartMs)} – ${formatDuration(s.timeEndMs)})`
        : "";
    doc.moveDown(0.5);
    doc
      .fontSize(FONT_SIZE_H3)
      .fillColor(COLOR_TEXT)
      .text(s.title, { continued: range.length > 0 });
    if (range.length > 0) {
      doc
        .fontSize(FONT_SIZE_SMALL)
        .fillColor(COLOR_MUTED)
        .text(range);
    }
    doc.moveDown(0.1);
    for (const p of s.points) {
      renderBulletLine(doc, p);
    }
  }
}

function renderBulletLine(doc: PDFKit.PDFDocument, text: string): void {
  doc
    .fontSize(FONT_SIZE_BODY)
    .fillColor(COLOR_TEXT)
    .text(`• ${stripInline(text)}`, {
      indent: 12,
      paragraphGap: 2,
    });
}

// --------- markdown -> pdf ---------
//
// Lightweight walker for the subset our minutes use:
//   #/##/### headings, blank-line-separated paragraphs, "- "/"* " bullet lists,
//   "1. " numbered lists, "> " block quotes. Inline **bold** / _italic_ /
//   `code` are flattened — pdfkit needs a second font registration to render
//   bold/italic in mixed runs, which is more complexity than the minutes
//   markdown justifies. We strip the markers so the text reads cleanly.

function renderMarkdown(doc: PDFKit.PDFDocument, md: string): void {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === "") {
      i += 1;
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /^###\s+(.*)$/.exec(line))) {
      doc.moveDown(0.5);
      doc
        .fontSize(FONT_SIZE_H3)
        .fillColor(COLOR_TEXT)
        .text(stripInline(m[1]));
      doc.moveDown(0.2);
      i += 1;
      continue;
    }
    if ((m = /^##\s+(.*)$/.exec(line))) {
      doc.moveDown(0.6);
      doc
        .fontSize(FONT_SIZE_H2)
        .fillColor(COLOR_TEXT)
        .text(stripInline(m[1]));
      doc.moveDown(0.2);
      i += 1;
      continue;
    }
    if ((m = /^#\s+(.*)$/.exec(line))) {
      doc.moveDown(0.7);
      doc
        .fontSize(FONT_SIZE_H1)
        .fillColor(COLOR_TEXT)
        .text(stripInline(m[1]));
      doc.moveDown(0.3);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        const item = lines[i].trim().replace(/^[-*]\s+/, "");
        renderBulletLine(doc, item);
        i += 1;
      }
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      let n = 1;
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const item = lines[i].trim().replace(/^\d+\.\s+/, "");
        doc
          .fontSize(FONT_SIZE_BODY)
          .fillColor(COLOR_TEXT)
          .text(`${n}. ${stripInline(item)}`, {
            indent: 12,
            paragraphGap: 2,
          });
        n += 1;
        i += 1;
      }
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = line.replace(/^>\s?/, "");
      doc
        .fontSize(FONT_SIZE_BODY)
        .fillColor(COLOR_MUTED)
        .text(stripInline(quote), {
          indent: 16,
          oblique: true,
          paragraphGap: 4,
        });
      i += 1;
      continue;
    }

    // Paragraph: collect contiguous non-empty, non-special lines.
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,3}\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim())
    ) {
      buf.push(lines[i].trim());
      i += 1;
    }
    doc
      .fontSize(FONT_SIZE_BODY)
      .fillColor(COLOR_TEXT)
      .text(stripInline(buf.join(" ")), { paragraphGap: 4 });
  }
}

/**
 * Strip the inline markdown markers (**bold**, _italic_, `code`) without
 * trying to render them as styled runs. We keep the visible text intact so
 * Chinese / English content reads correctly in the PDF.
 */
function stripInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
