import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";
import { getLLMProvider } from "@/lib/llm";
import { buildTermExtractPrompt } from "@/lib/prompts/term-extract";
import { toExtractedTermDTO } from "@/lib/api/dto";
import type {
  ExtractTermsResponse,
  ExtractedTermDTO,
} from "@/lib/contracts";

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

const CONTEXT_CAP = 500;

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  return t;
}

function parseTermsJson(raw: string): Array<{
  term: string;
  definition?: string | null;
}> {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      const aStart = text.indexOf("[");
      const aEnd = text.lastIndexOf("]");
      if (aStart >= 0 && aEnd > aStart) {
        try {
          parsed = JSON.parse(text.slice(aStart, aEnd + 1));
        } catch {
          parsed = null;
        }
      }
    }
  }
  let arr: unknown[] = [];
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else {
      const t = (parsed as Record<string, unknown>).terms;
      if (Array.isArray(t)) arr = t;
    }
  }
  return arr
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        const term = item.trim();
        if (!term) return null;
        return { term, definition: null };
      }
      if (typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const term = typeof o.term === "string" ? o.term.trim() : "";
      if (!term) return null;
      const definition =
        typeof o.definition === "string" && o.definition.trim().length
          ? o.definition.trim()
          : null;
      return { term, definition };
    })
    .filter(
      (x): x is { term: string; definition: string | null } => x !== null
    );
}

async function streamToString(
  body: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

function dedupTerms(existing: string, additions: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const piece of (existing ?? "").split(";")) {
    const v = piece.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      parts.push(v);
    }
  }
  for (const add of additions) {
    const v = add.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      parts.push(v);
    }
  }
  let combined = parts.join("; ");
  if (combined.length > CONTEXT_CAP) {
    combined = combined.slice(0, CONTEXT_CAP);
    const lastSemi = combined.lastIndexOf(";");
    if (lastSemi > 0) combined = combined.slice(0, lastSemi);
  }
  return combined;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const userId = await getDevUserId();
  const { id: folderId, docId } = await params;

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, userId },
  });
  if (!folder) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  const doc = await prisma.document.findFirst({
    where: { id: docId, folderId },
  });
  if (!doc) {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }

  // Mark as processing (best-effort)
  try {
    await prisma.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "processing" },
    });
  } catch {
    // ignore
  }

  const fileType = (doc.fileType || "").toLowerCase();
  const isText = TEXT_TYPES.has(fileType);

  if (!isText) {
    // Phase 1: PDF / DOCX / PPTX / etc. parsing is not yet implemented.
    await prisma.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "failed" },
    });
    const note = `Term extraction for ${doc.fileType} is not implemented in Phase 1 — falls back to manual entry.`;
    let placeholder: ExtractedTermDTO;
    try {
      const row = await prisma.extractedTerm.create({
        data: {
          documentId: doc.id,
          term: doc.fileName,
          definition: note,
        },
      });
      placeholder = toExtractedTermDTO(row);
    } catch {
      placeholder = {
        id: "placeholder",
        term: doc.fileName,
        definition: note,
      };
    }
    const resp: ExtractTermsResponse = {
      documentId: doc.id,
      status: "failed",
      terms: [placeholder],
    };
    return NextResponse.json(resp);
  }

  // Text/markdown path
  const storage = getStorageProvider();
  let raw: string;
  try {
    const got = await storage.getStream(doc.storageKey);
    raw = await streamToString(got.body);
  } catch (err) {
    await prisma.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "failed" },
    });
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to read document",
      },
      { status: 502 }
    );
  }

  const messages = buildTermExtractPrompt({
    documentText: raw,
    language: folder.targetLang ?? folder.sourceLang ?? undefined,
  });

  const llm = getLLMProvider();
  let llmRaw: string;
  try {
    llmRaw = await llm.generate(messages, { responseFormat: "json" });
  } catch (err) {
    await prisma.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "failed" },
    });
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "LLM extraction failed",
      },
      { status: 502 }
    );
  }

  const parsedTerms = parseTermsJson(llmRaw);

  // Persist terms, update doc status, update folder context.
  const created = await prisma.$transaction(async (tx) => {
    await tx.extractedTerm.deleteMany({ where: { documentId: doc.id } });
    const rows: ExtractedTermDTO[] = [];
    for (const t of parsedTerms) {
      const row = await tx.extractedTerm.create({
        data: {
          documentId: doc.id,
          term: t.term,
          definition: t.definition ?? null,
        },
      });
      rows.push(toExtractedTermDTO(row));
    }
    await tx.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "done" },
    });
    const next = dedupTerms(
      folder.transcriptionContext ?? "",
      parsedTerms.map((t) => t.term)
    );
    await tx.folder.update({
      where: { id: folder.id },
      data: { transcriptionContext: next },
    });
    return rows;
  });

  const resp: ExtractTermsResponse = {
    documentId: doc.id,
    status: "done",
    terms: created,
  };
  return NextResponse.json(resp);
}
