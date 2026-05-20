import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getLLMProvider } from "@/lib/llm";
import { buildMinutesPrompt } from "@/lib/prompts/minutes";
import { toMinutesDTO, toSegmentDTO } from "@/lib/api/dto";
import type { MinutesSection } from "@/lib/contracts";

const GenerateMinutesBodySchema = z
  .object({
    language: z.string().optional(),
    styleHint: z.string().optional(),
  })
  .default({});

function composeContentMd(
  sections: MinutesSection[],
  summary?: string
): string {
  const parts: string[] = [];
  for (const s of sections) {
    parts.push(`## ${s.title || "Untitled"}`);
    // Prefer narrative prose; fall back to legacy bullet points so rows
    // persisted before the narrative refactor still render cleanly.
    if (s.narrative && s.narrative.trim()) {
      parts.push(s.narrative.trim());
    } else if (Array.isArray(s.points) && s.points.length > 0) {
      for (const p of s.points) {
        parts.push(`- ${p}`);
      }
    }
    parts.push("");
  }
  if (summary && summary.trim()) {
    parts.push("## Summary");
    parts.push(summary.trim());
  }
  return parts.join("\n").trim();
}

function safeParseSections(raw: string): {
  sections: MinutesSection[];
  summary: string;
} {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
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
  }
  const sections: MinutesSection[] = [];
  let summary = "";
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.sections)) {
      for (const s of obj.sections) {
        if (!s || typeof s !== "object") continue;
        const sec = s as Record<string, unknown>;
        const title = typeof sec.title === "string" ? sec.title : "";
        const narrative =
          typeof sec.narrative === "string" ? sec.narrative : undefined;
        const points = Array.isArray(sec.points)
          ? sec.points.filter((p): p is string => typeof p === "string")
          : [];
        const out: MinutesSection = { title, narrative, points };
        if (typeof sec.timeStartMs === "number")
          out.timeStartMs = sec.timeStartMs;
        if (typeof sec.timeEndMs === "number")
          out.timeEndMs = sec.timeEndMs;
        sections.push(out);
      }
    }
    if (typeof obj.summary === "string") summary = obj.summary;
  }
  return { sections, summary };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: sessionId } = await params;

  let body: z.infer<typeof GenerateMinutesBodySchema>;
  try {
    const json = await req.json().catch(() => ({}));
    body = GenerateMinutesBodySchema.parse(json ?? {});
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const segments = await prisma.segment.findMany({
    where: { sessionId },
    orderBy: { segmentIndex: "asc" },
  });

  const messages = buildMinutesPrompt({
    segments: segments.map(toSegmentDTO),
    sourceLang: session.sourceLang,
    targetLang: body.language ?? session.targetLang,
    styleHint: body.styleHint,
  });

  const llm = getLLMProvider();
  // Minutes benefit from a stronger reasoning model — DeepSeek v4-pro
  // produces dramatically better section structure + narrative quality
  // than v4-flash for the same prompt. Respect LLM_MINUTES_MODEL env if
  // set; otherwise default to v4-pro for this task only (chat / translate
  // / etc. still use whatever the default provider picks).
  const minutesModel = process.env.LLM_MINUTES_MODEL || "deepseek-v4-pro";
  let raw: string;
  try {
    raw = await llm.generate(messages, {
      model: minutesModel,
      responseFormat: "json",
      // DeepSeek caps max_tokens at 8192 regardless of model; anything
      // higher is silently clamped. 8192 ≈ 12-16k Chinese chars, enough
      // for 8 narrative sections + summary.
      maxTokens: 8192,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "LLM generation failed",
      },
      { status: 502 }
    );
  }

  const { sections, summary } = safeParseSections(raw);
  const contentMd = composeContentMd(sections, summary);

  const upserted = await prisma.minutes.upsert({
    where: { sessionId },
    create: {
      sessionId,
      contentMd,
      sectionsJson: sections as unknown as object,
      model: llm.id,
      status: "done",
    },
    update: {
      contentMd,
      sectionsJson: sections as unknown as object,
      model: llm.id,
      status: "done",
    },
  });

  return NextResponse.json(toMinutesDTO(upserted));
}
