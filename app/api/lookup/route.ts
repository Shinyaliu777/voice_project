import { NextResponse } from "next/server";
import { z } from "zod";
import { getDevUserId } from "@/lib/dev-user";
import { getLLMProvider } from "@/lib/llm";
import { LANGUAGE_NAMES, type LLMMessage, type SupportedLanguage } from "@/lib/contracts";

const LookupBodySchema = z.object({
  text: z.string().min(1).max(2000),
  question: z.string().min(1).max(1000).optional(),
  sourceLanguage: z.string().min(2).max(16).optional(),
  targetLanguage: z.string().min(2).max(16).optional(),
});

type LookupBody = z.infer<typeof LookupBodySchema>;

function languageDisplay(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  const name = LANGUAGE_NAMES[code as SupportedLanguage];
  return name ? `${name} (${code})` : code;
}

function buildSystemPrompt(input: {
  text: string;
  question?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}): string {
  const sourceDisp = languageDisplay(input.sourceLanguage, "the source language");
  const targetDisp = languageDisplay(input.targetLanguage, "the user's preferred language");

  const lines: string[] = [
    "You are LecSync, a friendly transcript assistant who helps a user understand a small fragment of text they highlighted in a recording.",
    `The highlighted text is in ${sourceDisp}.`,
    `Reply in ${targetDisp}. Keep your answer concise, plain prose, no markdown headings.`,
  ];

  if (input.question && input.question.trim().length > 0) {
    lines.push(
      "The user has a specific question about this fragment. Answer the question directly, citing the fragment when relevant. Do not invent context that is not present in the fragment."
    );
  } else {
    lines.push(
      "Provide a short definition or explanation of the highlighted text. If it is a single word or phrase, give the meaning, part of speech (if applicable), and one short example sentence. If it is a full sentence, give a one-paragraph plain-language paraphrase."
    );
    lines.push("Keep the whole answer under 120 words.");
  }

  return lines.join("\n");
}

function buildUserPrompt(input: LookupBody): string {
  const lines: string[] = [];
  lines.push("Highlighted text:");
  lines.push("“" + input.text.trim() + "”");
  if (input.question && input.question.trim().length > 0) {
    lines.push("");
    lines.push("Question:");
    lines.push(input.question.trim());
  }
  return lines.join("\n");
}

export async function POST(req: Request) {
  // Authorization: scope to dev user (no per-user resource lookup needed,
  // but we still confirm a dev user exists so future auth is a drop-in).
  await getDevUserId();

  let body: LookupBody;
  try {
    const json = await req.json();
    body = LookupBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const systemContent = buildSystemPrompt(body);
  const userContent = buildUserPrompt(body);

  const messages: LLMMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const llm = getLLMProvider();
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: object) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
      try {
        for await (const delta of llm.stream(messages, { temperature: 0.3 })) {
          if (!delta) continue;
          send({ type: "text", value: delta });
        }
        send({ type: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Lookup streaming failed";
        send({ type: "error", message });
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
