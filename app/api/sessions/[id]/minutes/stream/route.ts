import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getLLMProvider } from "@/lib/llm";
import {
  buildIncrementalMinutesPrompt,
  buildMinutesPrompt,
} from "@/lib/prompts/minutes";
import { toSegmentDTO } from "@/lib/api/dto";
import type {
  IncrementalMinutesUpdate,
  MinutesSection,
  MinutesStreamEvent,
} from "@/lib/contracts";

const GenerateMinutesBodySchema = z
  .object({
    language: z.string().optional(),
    styleHint: z.string().optional(),
  })
  .default({});

const IncrementalSectionSchema = z.object({
  title: z.string(),
  // narrative is the new preferred shape; points is legacy fallback for
  // older clients still posting bullet arrays.
  narrative: z.string().optional(),
  points: z.array(z.string()).default([]),
  timeStartMs: z.number().optional(),
  timeEndMs: z.number().optional(),
});
const IncrementalBodySchema = z.object({
  mode: z.literal("incremental"),
  confirmedSections: z.array(IncrementalSectionSchema),
  pendingSection: IncrementalSectionSchema.nullable().optional(),
  newTranscripts: z.array(
    z.object({
      segmentId: z.string(),
      text: z.string(),
      timestamp: z.number(),
    })
  ),
  language: z.string().optional(),
});

function composeContentMd(
  sections: MinutesSection[],
  summary?: string
): string {
  const parts: string[] = [];
  for (const s of sections) {
    parts.push(`## ${s.title || "Untitled"}`);
    // Prefer narrative prose; fall back to legacy bullets for rows
    // persisted before the narrative refactor.
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

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  return t;
}

function tryParseFullJson(
  text: string
): { sections: MinutesSection[]; summary: string } | null {
  const stripped = stripFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(stripped.slice(start, end + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const sections: MinutesSection[] = Array.isArray(obj.sections)
    ? obj.sections
        .map((s): MinutesSection | null => {
          if (!s || typeof s !== "object") return null;
          const sec = s as Record<string, unknown>;
          const title = typeof sec.title === "string" ? sec.title : "";
          const narrative =
            typeof sec.narrative === "string" ? sec.narrative : undefined;
          const points = Array.isArray(sec.points)
            ? sec.points.filter((p): p is string => typeof p === "string")
            : [];
          const timeStartMs =
            typeof sec.timeStartMs === "number" ? sec.timeStartMs : undefined;
          const timeEndMs =
            typeof sec.timeEndMs === "number" ? sec.timeEndMs : undefined;
          return { title, narrative, points, timeStartMs, timeEndMs };
        })
        .filter((x): x is MinutesSection => x !== null)
    : [];
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  return { sections, summary };
}

/**
 * Incrementally extract balanced-brace JSON objects from a substring of the
 * accumulated buffer that starts inside the `sections` array. Returns an
 * array of fully-formed section objects parsed so far, and the cursor
 * position to resume scanning from.
 */
function extractCompleteSections(
  buffer: string,
  cursor: number
): { sections: MinutesSection[]; newCursor: number } {
  // Locate "sections" array opener if not yet past it
  const out: MinutesSection[] = [];
  let i = cursor;
  if (i === 0) {
    const sIdx = buffer.search(/"sections"\s*:\s*\[/);
    if (sIdx < 0) return { sections: out, newCursor: cursor };
    const bracketIdx = buffer.indexOf("[", sIdx);
    if (bracketIdx < 0) return { sections: out, newCursor: cursor };
    i = bracketIdx + 1;
  }
  // Scan for { ... } objects with brace balancing, ignoring strings
  while (i < buffer.length) {
    // skip whitespace and commas
    while (i < buffer.length && /[\s,]/.test(buffer[i])) i++;
    if (i >= buffer.length) break;
    if (buffer[i] === "]") {
      // end of sections array
      return { sections: out, newCursor: i };
    }
    if (buffer[i] !== "{") {
      // unexpected, advance
      i++;
      continue;
    }
    const startObj = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let endObj = -1;
    for (let j = i; j < buffer.length; j++) {
      const ch = buffer[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endObj = j;
          break;
        }
      }
    }
    if (endObj < 0) {
      // incomplete; wait for more data
      return { sections: out, newCursor: startObj };
    }
    const objStr = buffer.slice(startObj, endObj + 1);
    try {
      const parsedObj = JSON.parse(objStr) as Record<string, unknown>;
      const title =
        typeof parsedObj.title === "string" ? parsedObj.title : "";
      const narrative =
        typeof parsedObj.narrative === "string"
          ? parsedObj.narrative
          : undefined;
      const points = Array.isArray(parsedObj.points)
        ? (parsedObj.points as unknown[]).filter(
            (p): p is string => typeof p === "string"
          )
        : [];
      const timeStartMs =
        typeof parsedObj.timeStartMs === "number"
          ? parsedObj.timeStartMs
          : undefined;
      const timeEndMs =
        typeof parsedObj.timeEndMs === "number"
          ? parsedObj.timeEndMs
          : undefined;
      out.push({ title, narrative, points, timeStartMs, timeEndMs });
    } catch {
      // skip malformed
    }
    i = endObj + 1;
  }
  return { sections: out, newCursor: i };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: sessionId } = await params;

  let rawJson: unknown;
  try {
    rawJson = await req.json().catch(() => ({}));
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Branch on whether this is the new incremental shape or the legacy full
  // regeneration body. Incremental requests have `mode: "incremental"`.
  const isIncremental =
    typeof rawJson === "object" &&
    rawJson !== null &&
    (rawJson as { mode?: unknown }).mode === "incremental";

  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (isIncremental) {
    return handleIncrementalStream(rawJson, session);
  }

  let body: z.infer<typeof GenerateMinutesBodySchema>;
  try {
    body = GenerateMinutesBodySchema.parse(rawJson ?? {});
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
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

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: MinutesStreamEvent) =>
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify(evt)}\n\n`)
        );

      // mark minutes as streaming up front (best-effort)
      try {
        await prisma.minutes.upsert({
          where: { sessionId },
          create: {
            sessionId,
            contentMd: "",
            sectionsJson: [] as unknown as object,
            model: llm.id,
            status: "streaming",
          },
          update: { status: "streaming", model: llm.id },
        });
      } catch {
        // ignore
      }

      let buffer = "";
      let cursor = 0;
      let emittedCount = 0;
      let finalized = false;

      try {
        for await (const delta of llm.stream(messages, {
          responseFormat: "json",
          // Narrative prose is denser than bullets — bump the budget.
          maxTokens: 16384,
        })) {
          if (!delta) continue;
          buffer += delta;

          // Periodically try to extract more complete section objects
          const { sections, newCursor } = extractCompleteSections(
            buffer,
            cursor
          );
          if (sections.length > emittedCount) {
            for (let i = emittedCount; i < sections.length; i++) {
              send({ type: "section_confirmed", section: sections[i] });
            }
            emittedCount = sections.length;
          }
          cursor = newCursor;
        }

        // Stream finished — try to fully parse the buffer
        const full = tryParseFullJson(buffer);
        let sections: MinutesSection[] = [];
        let summary = "";
        if (full) {
          sections = full.sections;
          summary = full.summary;
        }

        // If incremental parsing missed any sections, emit them now
        for (let i = emittedCount; i < sections.length; i++) {
          send({ type: "section_confirmed", section: sections[i] });
        }
        emittedCount = sections.length;

        const contentMd = composeContentMd(sections, summary);

        // Persist final
        try {
          await prisma.minutes.upsert({
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
        } catch {
          // ignore persistence error after we've already streamed
        }

        send({ type: "minutes_final", contentMd });
        finalized = true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Streaming failed";
        try {
          await prisma.minutes.update({
            where: { sessionId },
            data: { status: "error" },
          });
        } catch {
          // ignore
        }
        send({ type: "error", message });
      } finally {
        if (!finalized) {
          // ensure something is sent if for-await never produced data
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * Incremental live-minutes stream. Client posts {confirmedSections,
 * pendingSection?, newTranscripts, language} and we ask the LLM whether the
 * topic shifted + what bullets to add. The response is sent as ONE SSE event
 * (incremental_update). This is dramatically cheaper than re-feeding the
 * whole transcript on every refresh — token use stays constant per call.
 */
async function handleIncrementalStream(
  rawBody: unknown,
  session: { id: string; sourceLang: string; targetLang: string }
): Promise<Response> {
  let body: z.infer<typeof IncrementalBodySchema>;
  try {
    body = IncrementalBodySchema.parse(rawBody);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 400 }
    );
  }

  // Empty newTranscripts → nothing to do; reply with a no-op update so the
  // client can finish its in-flight stream without throwing.
  if (body.newTranscripts.length === 0) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const noop: IncrementalMinutesUpdate = {
          topicChanged: false,
          currentTopic: {
            title: body.pendingSection?.title ?? "",
            newNarrative: "",
            newPoints: [],
          },
        };
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: "incremental_update", update: noop } satisfies MinutesStreamEvent)}\n\n`
          )
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const messages = buildIncrementalMinutesPrompt({
    confirmedSections: body.confirmedSections,
    pendingSection: body.pendingSection ?? null,
    newTranscripts: body.newTranscripts,
    sourceLang: session.sourceLang,
    targetLang: body.language ?? session.targetLang,
  });

  const llm = getLLMProvider();
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: MinutesStreamEvent) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));

      try {
        // Use non-streaming generate — output is small (one JSON object) and
        // partial-JSON parsing complicates the consumer. Latency hit is
        // negligible (~200-500ms) vs the simplicity gained.
        const raw = await llm.generate(messages, {
          responseFormat: "json",
          maxTokens: 1024,
        });
        const stripped = raw
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/i, "");
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripped);
        } catch {
          const s = stripped.indexOf("{");
          const e = stripped.lastIndexOf("}");
          parsed = s >= 0 && e > s ? JSON.parse(stripped.slice(s, e + 1)) : null;
        }
        if (!parsed || typeof parsed !== "object") {
          throw new Error("LLM returned non-JSON");
        }
        const obj = parsed as Record<string, unknown>;
        const ct = (obj.currentTopic ?? {}) as Record<string, unknown>;
        const update: IncrementalMinutesUpdate = {
          topicChanged: Boolean(obj.topicChanged),
          currentTopic: {
            title: typeof ct.title === "string" ? ct.title : "",
            newNarrative:
              typeof ct.newNarrative === "string" ? ct.newNarrative : undefined,
            // Legacy: keep newPoints around so old clients that haven't
            // upgraded yet still receive some content. New prompt asks for
            // newNarrative, so this is usually empty.
            newPoints: Array.isArray(ct.newPoints)
              ? (ct.newPoints as unknown[]).filter(
                  (p): p is string => typeof p === "string"
                )
              : [],
            timeStartMs:
              typeof ct.timeStartMs === "number" ? ct.timeStartMs : undefined,
            timeEndMs:
              typeof ct.timeEndMs === "number" ? ct.timeEndMs : undefined,
          },
        };
        send({ type: "incremental_update", update });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Incremental failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
