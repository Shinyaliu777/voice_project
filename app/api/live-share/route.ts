import { NextResponse, type NextRequest } from "next/server";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

// URL-safe alphabet; 12 chars gives ~71 bits of entropy which is plenty for
// dev-share tokens that the host can revoke by deleting the row.
const tokenAlphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const makeToken = customAlphabet(tokenAlphabet, 12);

const bodySchema = z.object({
  sessionId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { sessionId } = parsed.data;

  // Verify the dev user owns the session before minting a token.
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Retry once on the rare token collision.
  let token = makeToken();
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await prisma.liveShareSession.findUnique({
      where: { token },
      select: { id: true },
    });
    if (!existing) break;
    token = makeToken();
  }

  await prisma.liveShareSession.create({
    data: { sessionId, token, userId },
  });

  // Build the viewer URL. Behind a reverse proxy (nginx, Cloudflare, etc.)
  // `req.nextUrl.origin` is the LOCAL origin (often http://localhost:3000),
  // so we honor X-Forwarded-* headers first and a PUBLIC_BASE_URL env var as
  // an explicit override.
  const envBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const hostHeader = req.headers.get("host");
  let origin: string;
  if (envBase) {
    origin = envBase;
  } else if (forwardedHost) {
    origin = `${forwardedProto ?? "https"}://${forwardedHost}`;
  } else if (hostHeader && !hostHeader.startsWith("localhost")) {
    // Direct request without a forwarding proxy but a non-localhost Host.
    const proto = req.nextUrl.protocol.replace(":", "") || "https";
    origin = `${proto}://${hostHeader}`;
  } else {
    origin = req.nextUrl.origin;
  }
  const url = `${origin}/share/live/${token}`;

  return NextResponse.json({ token, url }, { status: 201 });
}
