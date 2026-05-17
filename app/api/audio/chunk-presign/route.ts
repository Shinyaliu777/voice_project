import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import type { ChunkPresignResponse } from "@/lib/contracts";

const bodySchema = z.object({
  sessionId: z.string().min(1),
  chunkIndex: z.number().int().min(0),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(0).max(500 * 1024 * 1024),
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
  const { sessionId, chunkIndex, contentType, sizeBytes } = parsed.data;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const chunkId = crypto.randomUUID();
  const ext = extFromContentType(contentType);

  const { getStorageProvider } = await import("@/lib/storage");
  const storage = getStorageProvider();
  const key = storage.keyForChunk(sessionId, chunkIndex, ext);

  let presign;
  try {
    presign = await storage.presignPut({
      key,
      contentType,
      sizeBytes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to presign", details: message },
      { status: 502 }
    );
  }

  const resp: ChunkPresignResponse = {
    ...presign,
    chunkId,
    storageKey: key,
  };
  return NextResponse.json(resp);
}
