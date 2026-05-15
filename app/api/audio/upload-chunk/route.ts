import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

// Audio chunks may be a few MB each — disable body size cap by switching to
// the Node.js runtime where Next.js streams the request body in.
export const runtime = "nodejs";
// Don't cache anything for raw uploads.
export const dynamic = "force-dynamic";

const KEY_RE = /^audio\/([A-Za-z0-9_-]+)\/chunks\/[A-Za-z0-9._/-]+$/;

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
