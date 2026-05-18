import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId, UnauthenticatedError } from "@/lib/dev-user";
import { ensureQuota, QuotaExceededError } from "@/lib/quota";
import { getLLMProvider } from "@/lib/llm";
import { buildChatSystemPrompt } from "@/lib/prompts/chat";
import type { LLMMessage } from "@/lib/contracts";

const ChatRequestBodySchema = z.object({
  chatSessionId: z.string().min(1),
  message: z.string().min(1),
  model: z.string().optional(),
  /**
   * When true, treat this request as a "重新生成" of the most recent
   * assistant reply. The route will:
   *  - delete the most recent assistant message in this chat (so it can be
   *    replaced by the new stream's output);
   *  - skip creating a duplicate user message when `message` matches the
   *    last persisted user message (avoids stacking identical turns).
   */
  regenerate: z.boolean().optional(),
});

const MAX_SNIPPET_CHARS = 8000;

function buildTranscriptSnippet(
  segments: Array<{
    segmentIndex: number;
    audioStartMs: number;
    audioEndMs: number;
    speakerId: number | null;
    sourceText: string;
    translatedText: string | null;
  }>
): string {
  // Format consistent with the prompt builders: keep the last segments that
  // fit under the char budget so the model has freshest context.
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const speaker =
      s.speakerId != null ? `(speaker ${s.speakerId})` : "(speaker ?)";
    const time = `[${s.audioStartMs}-${s.audioEndMs}]`;
    const src = (s.sourceText ?? "").replace(/\s+/g, " ").trim();
    const tgt = (s.translatedText ?? "").replace(/\s+/g, " ").trim();
    lines.push(`[#${i}] ${speaker} ${time} ${src} | ${tgt}`);
  }
  let joined = lines.join("\n");
  if (joined.length > MAX_SNIPPET_CHARS) {
    joined = joined.slice(joined.length - MAX_SNIPPET_CHARS);
    // re-anchor on the first newline so we don't break a line mid-record
    const nl = joined.indexOf("\n");
    if (nl > 0) joined = joined.slice(nl + 1);
  }
  return joined;
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await getDevUserId();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  // Daily chat quota gate.
  try {
    await ensureQuota(userId, "chat");
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      return NextResponse.json(
        { error: "Quota exceeded", kind: e.kind, info: e.info },
        { status: 402 }
      );
    }
    throw e;
  }

  let body: z.infer<typeof ChatRequestBodySchema>;
  try {
    const json = await req.json();
    body = ChatRequestBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  // Load the chat session scoped to the dev user
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: body.chatSessionId, userId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!chatSession) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  // Load parent recording session (if any) for context
  let parentSession: {
    id: string;
    title: string;
    sourceLang: string;
    targetLang: string;
  } | null = null;
  let transcriptSnippet: string | undefined;
  if (chatSession.sessionId) {
    const sess = await prisma.session.findFirst({
      where: { id: chatSession.sessionId, userId },
      select: {
        id: true,
        title: true,
        sourceLang: true,
        targetLang: true,
      },
    });
    if (sess) {
      parentSession = sess;
      const segs = await prisma.segment.findMany({
        where: { sessionId: sess.id },
        orderBy: { segmentIndex: "asc" },
        select: {
          segmentIndex: true,
          audioStartMs: true,
          audioEndMs: true,
          speakerId: true,
          sourceText: true,
          translatedText: true,
        },
      });
      transcriptSnippet = buildTranscriptSnippet(segs);
    }
  }

  // Regenerate flow: drop the last assistant message so the new stream
  // replaces it in-place rather than appending another reply.
  if (body.regenerate) {
    const lastAssistant = await prisma.chatMessage.findFirst({
      where: { chatSessionId: chatSession.id, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (lastAssistant) {
      await prisma.chatMessage.delete({ where: { id: lastAssistant.id } });
    }
  }

  // Reload messages after potential deletion above so `history` reflects the
  // current state of the chat.
  const persistedMessages = body.regenerate
    ? await prisma.chatMessage.findMany({
        where: { chatSessionId: chatSession.id },
        orderBy: { createdAt: "asc" },
      })
    : chatSession.messages;

  // Save the user message — unless we're regenerating and the last persisted
  // user message already has identical content (avoid stacking duplicates).
  const lastPersisted = persistedMessages[persistedMessages.length - 1];
  const userAlreadyPersisted =
    body.regenerate &&
    lastPersisted?.role === "user" &&
    lastPersisted.content === body.message;

  if (!userAlreadyPersisted) {
    await prisma.chatMessage.create({
      data: {
        chatSessionId: chatSession.id,
        role: "user",
        content: body.message,
      },
    });
  }

  // Build messages: system + prior history + new user message.
  //
  // Important: only pass `recordingTitle` when a recording is actually bound.
  // Falling back to `chatSession.title` here causes the assistant to think
  // every conversation refers to a recording — the very bug we're fixing.
  const systemContent = buildChatSystemPrompt({
    recordingTitle: parentSession?.title ?? null,
    sourceLang: parentSession?.sourceLang,
    targetLang: parentSession?.targetLang,
    transcriptSnippet,
  });
  // For regenerate: `persistedMessages` already includes the user message we
  // want to answer (we skipped the duplicate save above), so don't append
  // another copy. For the normal path, append the freshly-saved user message.
  const history: LLMMessage[] = (
    userAlreadyPersisted ? persistedMessages : chatSession.messages
  ).map((m) => ({
    role: m.role as LLMMessage["role"],
    content: m.content,
  }));
  const messages: LLMMessage[] = [
    { role: "system", content: systemContent },
    ...history,
    ...(userAlreadyPersisted
      ? []
      : [{ role: "user" as const, content: body.message }]),
  ];

  // Touch chat session so it bubbles up in the list (best-effort)
  prisma.chatSession
    .update({
      where: { id: chatSession.id },
      data: { updatedAt: new Date() },
    })
    .catch(() => {});

  const llm = getLLMProvider();
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: object) =>
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify(evt)}\n\n`)
        );

      let assembled = "";
      try {
        for await (const delta of llm.stream(messages, {
          model: body.model,
        })) {
          if (!delta) continue;
          assembled += delta;
          send({ type: "text", value: delta });
        }

        const saved = await prisma.chatMessage.create({
          data: {
            chatSessionId: chatSession.id,
            role: "assistant",
            content: assembled,
          },
        });
        send({ type: "done", messageId: saved.id });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Chat streaming failed";
        if (assembled.trim()) {
          try {
            await prisma.chatMessage.create({
              data: {
                chatSessionId: chatSession.id,
                role: "assistant",
                content: assembled,
              },
            });
          } catch {
            // ignore
          }
        }
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
