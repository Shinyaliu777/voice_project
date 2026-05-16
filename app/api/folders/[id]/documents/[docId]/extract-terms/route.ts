import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";
import { getLLMProvider } from "@/lib/llm";
import { buildTermExtractPrompt } from "@/lib/prompts/term-extract";
import { toExtractedTermDTO } from "@/lib/api/dto";
import { parseDocument } from "@/lib/document-parser";
import type {
  ExtractTermsResponse,
  ExtractedTermDTO,
} from "@/lib/contracts";

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

async function streamToBuffer(
  body: ReadableStream<Uint8Array>
): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
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

  try {
    await prisma.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "processing" },
    });
  } catch {
    // ignore status update failures; we'll still try the work
  }

  // 1. Fetch the file from storage and parse it to text.
  const storage = getStorageProvider();
  let parsedText: string;
  try {
    const got = await storage.getStream(doc.storageKey);
    const buffer = await streamToBuffer(got.body);
    const result = await parseDocument(buffer, doc.fileType, doc.fileName);
    parsedText = result.text.trim();
  } catch (err) {
    await prisma.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "failed" },
    });
    return NextResponse.json(
      {
        documentId: doc.id,
        status: "failed",
        terms: [],
        error:
          err instanceof Error ? err.message : "Failed to read or parse document",
      } satisfies ExtractTermsResponse & { error: string },
      { status: 502 }
    );
  }

  if (!parsedText) {
    await prisma.document.update({
      where: { id: doc.id },
      data: { extractionStatus: "failed" },
    });
    const resp: ExtractTermsResponse = {
      documentId: doc.id,
      status: "failed",
      terms: [],
    };
    return NextResponse.json(resp);
  }

  // 2. Run the term extractor LLM.
  const messages = buildTermExtractPrompt({
    documentText: parsedText,
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

  // 3. Persist terms, mark done, update folder context.
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
