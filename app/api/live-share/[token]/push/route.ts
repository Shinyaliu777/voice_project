import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { broadcast } from "@/lib/live-share/broadcaster";

export const runtime = "nodejs";

/**
 * Host-side push. The recording client posts every utterance / segment payload
 * here; we validate token ownership and forward to in-memory subscribers.
 *
 * Body shape is intentionally loose: anything with a `type` string is accepted
 * (e.g. `{ type: "utterance", utterance: {...} }` or
 * `{ type: "segment", segment: {...} }`). The viewer normalizes downstream.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const userId = await getDevUserId();
  const { token } = await ctx.params;

  const share = await prisma.liveShareSession.findUnique({
    where: { token },
    select: { id: true, userId: true },
  });
  if (!share) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }
  if (share.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  broadcast(token, body as object);
  return NextResponse.json({ ok: true });
}
