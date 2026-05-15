import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getLLMProvider } from "@/lib/llm";
import { buildFlashcardCandidatesPrompt } from "@/lib/prompts/flashcards";
import { toSegmentDTO } from "@/lib/api/dto";
import type { FlashcardRecommendResponse } from "@/lib/contracts";

const FlashcardRecommendBodySchema = z.object({
  sourceSessionId: z.string().min(1),
  maxCards: z.number().int().min(1).max(50).optional(),
});

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  return t;
}

function safeParseCandidates(raw: string): Array<{
  front: string;
  back: string;
  sourceSegmentId?: string;
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
      const o = parsed as Record<string, unknown>;
      // A2's prompt emits `cards`; the contract uses `candidates`. Accept both.
      const fromCards = Array.isArray(o.cards) ? o.cards : null;
      const fromCandidates = Array.isArray(o.candidates) ? o.candidates : null;
      arr = fromCards ?? fromCandidates ?? [];
    }
  }
  const out: Array<{
    front: string;
    back: string;
    sourceSegmentId?: string;
  }> = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const front = typeof o.front === "string" ? o.front.trim() : "";
    const back = typeof o.back === "string" ? o.back.trim() : "";
    if (!front || !back) continue;
    const entry: { front: string; back: string; sourceSegmentId?: string } = {
      front,
      back,
    };
    if (typeof o.sourceSegmentId === "string" && o.sourceSegmentId.length) {
      entry.sourceSegmentId = o.sourceSegmentId;
    }
    out.push(entry);
  }
  return out;
}

export async function POST(req: Request) {
  const userId = await getDevUserId();

  let body: z.infer<typeof FlashcardRecommendBodySchema>;
  try {
    const json = await req.json();
    body = FlashcardRecommendBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const session = await prisma.session.findFirst({
    where: { id: body.sourceSessionId, userId },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const segments = await prisma.segment.findMany({
    where: { sessionId: session.id },
    orderBy: { segmentIndex: "asc" },
  });

  const messages = buildFlashcardCandidatesPrompt({
    segments: segments.map(toSegmentDTO),
    targetLanguage: session.targetLang,
    maxCards: body.maxCards ?? 15,
  });

  const llm = getLLMProvider();
  let raw: string;
  try {
    raw = await llm.generate(messages, { responseFormat: "json" });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "LLM generation failed",
      },
      { status: 502 }
    );
  }

  const candidates = safeParseCandidates(raw);
  const resp: FlashcardRecommendResponse = { candidates };
  return NextResponse.json(resp);
}
