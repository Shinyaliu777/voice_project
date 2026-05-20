import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

// Audio chunks may be a few MB each — disable body size cap by switching to
// the Node.js runtime where Next.js streams the request body in.
export const runtime = "nodejs";
// Don't cache anything for raw uploads.
export const dynamic = "force-dynamic";

const KEY_RE = /^audio\/([A-Za-z0-9_-]+)\/chunks\/[A-Za-z0-9._/-]+$/;

/**
 * PUT path: paired with /api/audio/chunk-presign — Recorder pre-signs,
 * PUTs raw bytes against `?key=<storageKey>`, then POSTs /chunk-record
 * to persist the DB row. Three round-trips per chunk; works fine for
 * the steady-state pipeline.
 */
export async function PUT(req: NextRequest) {
  const userId = await getDevUserId();

  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  if (!key) {
    return NextResponse.json({ error: "Missing ?key=" }, { status: 400 });
  }

  const match = KEY_RE.exec(key);
  if (!match) {
    return NextResponse.json({ error: "Invalid key shape" }, { status: 400 });
  }
  const sessionId = match[1];

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = req.body;
  if (!body) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  const contentType =
    req.headers.get("content-type") ?? "application/octet-stream";

  const { getStorageProvider } = await import("@/lib/storage");
  const storage = getStorageProvider();
  try {
    await storage.putStream(key, body, contentType);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Upload failed", details: message },
      { status: 502 }
    );
  }

  return new NextResponse(null, { status: 204 });
}

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
 * POST path: single-shot multipart used by `navigator.sendBeacon` from
 * the Recorder's `pagehide` handler. Beacons can't carry a JSON body or
 * set Authorization headers, and the page is closing so a 3-step
 * presign + PUT + record dance is unreliable — collapse it into one
 * request that does storage write + AudioChunk upsert in one go.
 *
 * Expected multipart fields:
 *   - sessionId:        string (FK to Session)
 *   - chunkIndex:       integer >= 0
 *   - durationSeconds:  number >= 0
 *   - contentType:      mime string (defaults from the part type)
 *   - file:             the blob itself
 *
 * Idempotent on (sessionId, chunkIndex): the AudioChunk row is
 * upserted, and a re-issued beacon for the same chunkIndex just
 * overwrites the storage object with the same bytes.
 */
export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart body" },
      { status: 400 }
    );
  }

  const sessionId = (form.get("sessionId") ?? "").toString().trim();
  const chunkIndexRaw = (form.get("chunkIndex") ?? "").toString().trim();
  const durationRaw = (form.get("durationSeconds") ?? "").toString().trim();
  const contentTypeRaw = (form.get("contentType") ?? "").toString().trim();
  const file = form.get("file");

  if (!sessionId || !chunkIndexRaw || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: "Missing sessionId / chunkIndex / file" },
      { status: 400 }
    );
  }

  const chunkIndex = Number.parseInt(chunkIndexRaw, 10);
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
    return NextResponse.json(
      { error: "chunkIndex must be a non-negative integer" },
      { status: 400 }
    );
  }
  const durationSeconds = Number.parseFloat(durationRaw);
  const safeDurationSec =
    Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? durationSeconds
      : 0;
  const contentType =
    contentTypeRaw || file.type || "application/octet-stream";

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = extFromContentType(contentType);
  const { getStorageProvider } = await import("@/lib/storage");
  const storage = getStorageProvider();
  const key = storage.keyForChunk(sessionId, chunkIndex, ext);

  let publicUrl: string;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const res = await storage.putStream(key, buf, contentType);
    publicUrl = res.publicUrl;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Upload failed", details: message },
      { status: 502 }
    );
  }

  await prisma.audioChunk.upsert({
    where: {
      sessionId_chunkIndex: { sessionId, chunkIndex },
    },
    create: {
      sessionId,
      chunkIndex,
      sizeBytes: file.size,
      durationMs: Math.round(safeDurationSec * 1000),
      contentType,
      storageKey: key,
      publicUrl,
    },
    update: {
      sizeBytes: file.size,
      durationMs: Math.round(safeDurationSec * 1000),
      contentType,
      storageKey: key,
      publicUrl,
    },
  });

  return NextResponse.json({ ok: true });
}
