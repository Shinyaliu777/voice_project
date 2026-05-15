import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getLLMProvider } from "@/lib/llm";
import { buildMinutesPrompt } from "@/lib/prompts/minutes";
import { toSegmentDTO } from "@/lib/api/dto";
import type { MinutesSection, MinutesStreamEvent } from "@/lib/contracts";

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
    if (Array.isArray(s.points)) {
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
          const points = Array.isArray(sec.points)
            ? sec.points.filter((p): p is string => typeof p === "string")
            : [];
          const timeStartMs =
            typeof sec.timeStartMs === "number" ? sec.timeStartMs : undefined;
          const timeEndMs =
            typeof sec.timeEndMs === "number" ? sec.timeEndMs : undefined;
          return { title, points, timeStartMs, timeEndMs };
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
      out.push({ title, points, timeStartMs, timeEndMs });
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
          maxTokens: 8192,
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
