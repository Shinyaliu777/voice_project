import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { audioFileUrl } from "@/lib/audio-url";
import type {
  FinalizeAudioResponse,
  StorageProvider,
} from "@/lib/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  sessionId: z.string().min(1),
  // Optional: when the client knows its own startedAtMs / pausedTime
  // it sends the wall-clock duration here. If absent (e.g. a recovery
  // call after a tab crash / page reload that lost the client clock),
  // we fall back to sum(AudioChunk.durationMs) which is the recorded
  // wall-clock time MediaRecorder produced anyway.
  totalDurationMs: z.number().int().min(0).optional(),
});

function extFromContentType(ct: string): string {
  const norm = ct.split(";")[0].trim().toLowerCase();
  switch (norm) {
    case "audio/webm":
      return "webm";
    case "audio/mp4":
    case "audio/mp4a-latm":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    default:
      return "bin";
  }
}

/**
 * Sequentially concatenate every chunk's stream into the destination key.
 * We expose this as a ReadableStream so the storage provider can pipe it
 * straight to disk/S3 without buffering the whole file in memory.
 */
function makeConcatStream(
  storage: StorageProvider,
  keys: string[]
): ReadableStream<Uint8Array> {
  let idx = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;

  async function nextReader(): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
    while (idx < keys.length) {
      const key = keys[idx++];
      const res = await storage.getStream(key);
      // Skip empty streams just in case.
      const reader = res.body.getReader();
      return reader;
    }
    return null;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!current) {
          current = await nextReader();
          if (!current) {
            controller.close();
            return;
          }
        }
        const { value, done } = await current.read();
        if (done) {
          current = null;
          // Loop pull again by enqueuing nothing — the consumer will call pull
          // again and we'll move to the next chunk.
          // To avoid spinning when all chunks are exhausted, attempt to roll
          // forward immediately.
          const nxt = await nextReader();
          if (!nxt) {
            controller.close();
            return;
          }
          current = nxt;
          const r = await current.read();
          if (r.done) {
            controller.close();
            return;
          }
          if (r.value && r.value.byteLength > 0) controller.enqueue(r.value);
          return;
        }
        if (value && value.byteLength > 0) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      if (current) {
        try {
          await current.cancel(reason);
        } catch {
          // ignore
        }
      }
    },
  });
}

export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { sessionId, totalDurationMs } = parsed.data;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const chunks = await prisma.audioChunk.findMany({
    where: { sessionId },
    orderBy: { chunkIndex: "asc" },
    select: {
      chunkIndex: true,
      contentType: true,
      storageKey: true,
      sizeBytes: true,
      durationMs: true,
    },
  });
  if (chunks.length === 0) {
    return NextResponse.json(
      { error: "No chunks uploaded" },
      { status: 400 }
    );
  }

  // Resolve duration: prefer the client-tracked wall clock (more accurate
  // — accounts for pause time), fall back to sum(chunks.durationMs) when
  // the client didn't or couldn't compute one. The fallback is the right
  // recovery path for sessions where the user closed the tab without
  // pressing "结束录制" and is now manually finalizing from the history
  // page; the client doesn't have the original startedAtMs anymore.
  const resolvedDurationMs =
    totalDurationMs !== undefined
      ? totalDurationMs
      : chunks.reduce((acc, c) => acc + (c.durationMs ?? 0), 0);

  const firstContentType = chunks[0].contentType;
  const ext = extFromContentType(firstContentType);

  const { getStorageProvider } = await import("@/lib/storage");
  const storage = getStorageProvider();
  const finalKey = storage.keyForFinalAudio(sessionId, ext);

  try {
    const concat = makeConcatStream(
      storage,
      chunks.map((c) => c.storageKey)
    );
    await storage.putStream(finalKey, concat, firstContentType);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: "error" },
    });
    return NextResponse.json(
      { error: "Finalize failed", details: message },
      { status: 502 }
    );
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      audioPath: finalKey,
      audioContentType: firstContentType,
      durationMs: resolvedDurationMs,
      status: "ready",
    },
  });

  const resp: FinalizeAudioResponse = {
    sessionId,
    audioPath: finalKey,
    audioContentType: firstContentType,
    durationMs: resolvedDurationMs,
    audioUrl: audioFileUrl(finalKey)!,
  };
  return NextResponse.json(resp);
}
