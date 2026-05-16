/**
 * Word (.docx) export for a session.
 *
 * Composition layer over the `docx` library. Renders:
 *   1. Title block (H1 + small meta line)
 *   2. AI Minutes — markdown (preferred) or section objects (fallback)
 *   3. Transcript — one block per segment with speaker / timestamp /
 *      source text / translated text in italic
 *
 * Returns a Buffer ready to be sent as the response body.
 *
 * Server-only. Do not import from a "use client" module.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
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

export async function generateSessionWordDoc(
  session: SessionLite,
  segments: SegmentDTO[],
  speakerNames: SpeakerName[],
  minutes: MinutesDTO | null
): Promise<Buffer> {
  const children: Paragraph[] = [];

  // --- Title block
  const niceTitle = (session.title ?? "").trim() || "未命名会话";
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: niceTitle, bold: true })],
    })
  );
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: buildMetaLine(session),
          italics: true,
          color: "555555",
          size: 20, // half-points => 10pt
        }),
      ],
      spacing: { after: 200 },
    })
  );

  // --- Minutes section
  children.push(sectionHeading("纪要 (AI Minutes)"));
  if (minutes && minutes.contentMd && minutes.contentMd.trim().length > 0) {
    children.push(...renderMarkdownAsParagraphs(minutes.contentMd));
  } else if (minutes && minutes.sections && minutes.sections.length > 0) {
    children.push(...renderSectionsAsParagraphs(minutes.sections));
  } else {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "暂无纪要。", italics: true, color: "888888" }),
        ],
      })
    );
  }

  // --- Transcript section
  children.push(sectionHeading("转录 (Transcript)"));
  if (segments.length === 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "暂无转录内容。", italics: true, color: "888888" }),
        ],
      })
    );
  } else {
    const speakerNameById = mapSpeakerNames(speakerNames);
    for (const seg of segments) {
      children.push(...renderSegmentBlock(seg, speakerNameById));
    }
  }

  const doc = new Document({
    creator: "Voice Project",
    title: niceTitle,
    description: "Session export",
    sections: [{ children }],
  });

  return await Packer.toBuffer(doc);
}

// --------- internal helpers ---------

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 360, after: 160 },
    children: [new TextRun({ text, bold: true })],
  });
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
  seg: SegmentDTO,
  speakerById: Map<number, string>
): Paragraph[] {
  const stamp = formatDuration(seg.audioStartMs);
  const speaker = speakerLabel(seg.speakerId, speakerById);

  const header = new Paragraph({
    spacing: { before: 120, after: 40 },
    children: [
      new TextRun({ text: `${speaker}  `, bold: true }),
      new TextRun({ text: stamp, color: "888888", size: 18 }),
    ],
  });

  const source = new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text: seg.sourceText.trim() })],
  });

  const out = [header, source];

  if (seg.translatedText && seg.translatedText.trim().length > 0) {
    out.push(
      new Paragraph({
        spacing: { after: 80 },
        children: [
          new TextRun({
            text: seg.translatedText.trim(),
            italics: true,
            color: "555555",
          }),
        ],
      })
    );
  }

  return out;
}

function renderSectionsAsParagraphs(
  sections: MinutesSection[]
): Paragraph[] {
  const out: Paragraph[] = [];
  for (const s of sections) {
    const range =
      typeof s.timeStartMs === "number" && typeof s.timeEndMs === "number"
        ? ` (${formatDuration(s.timeStartMs)} – ${formatDuration(s.timeEndMs)})`
        : "";
    out.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 240, after: 80 },
        children: [
          new TextRun({ text: s.title, bold: true }),
          ...(range
            ? [new TextRun({ text: range, color: "888888", size: 18 })]
            : []),
        ],
      })
    );
    for (const p of s.points) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 40 },
          children: [new TextRun({ text: p })],
        })
      );
    }
  }
  return out;
}

// --------- markdown -> docx paragraphs ---------
//
// Lightweight walker for the subset our minutes use:
//   #/##/### headings, blank-line-separated paragraphs, "- "/"* " bullet lists,
//   inline **bold** and _italic_, `inline code`.
//
// react-markdown handles the client side; here we want plain docx output so
// we re-parse rather than try to round-trip the React tree.

interface InlineRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  code?: boolean;
}

function renderMarkdownAsParagraphs(md: string): Paragraph[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: Paragraph[] = [];
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
      out.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 80 },
          children: parseInline(m[1]).map(toTextRun),
        })
      );
      i += 1;
      continue;
    }
    if ((m = /^##\s+(.*)$/.exec(line))) {
      out.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 100 },
          children: parseInline(m[1]).map(toTextRun),
        })
      );
      i += 1;
      continue;
    }
    if ((m = /^#\s+(.*)$/.exec(line))) {
      out.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 280, after: 120 },
          children: parseInline(m[1]).map(toTextRun),
        })
      );
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        const item = lines[i].trim().replace(/^[-*]\s+/, "");
        out.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: parseInline(item).map(toTextRun),
          })
        );
        i += 1;
      }
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const item = lines[i].trim().replace(/^\d+\.\s+/, "");
        out.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40 },
            children: parseInline(item).map(toTextRun),
          })
        );
        i += 1;
      }
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = line.replace(/^>\s?/, "");
      out.push(
        new Paragraph({
          spacing: { after: 80 },
          alignment: AlignmentType.LEFT,
          children: parseInline(quote).map((r) =>
            toTextRun({ ...r, italics: true })
          ),
        })
      );
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
    out.push(
      new Paragraph({
        spacing: { after: 80 },
        children: parseInline(buf.join(" ")).map(toTextRun),
      })
    );
  }

  return out;
}

function toTextRun(run: InlineRun): TextRun {
  return new TextRun({
    text: run.text,
    bold: run.bold,
    italics: run.italics,
    font: run.code ? "Courier New" : undefined,
  });
}

function parseInline(text: string): InlineRun[] {
  // Tokenize **bold**, _italic_, `code`. Plain runs in between.
  const out: InlineRun[] = [];
  const re = /(\*\*[^*]+\*\*)|(_[^_]+_)|(`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index) });
    }
    if (m[1]) {
      out.push({ text: m[1].slice(2, -2), bold: true });
    } else if (m[2]) {
      out.push({ text: m[2].slice(1, -1), italics: true });
    } else if (m[3]) {
      out.push({ text: m[3].slice(1, -1), code: true });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push({ text: text.slice(last) });
  }
  if (out.length === 0) out.push({ text: "" });
  return out;
}
