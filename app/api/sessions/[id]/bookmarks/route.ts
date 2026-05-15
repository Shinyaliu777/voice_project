import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toBookmarkDTO } from "@/lib/api/dto";

// The route folder is /sessions/[id]/bookmarks, where [id] is the sessionId.
// The contract also includes sessionId in the body — we check both match.
const createBodySchema = z.object({
  sessionId: z.string().min(1),
  atMs: z.number().int().min(0),
  note: z.string().max(2_000).optional(),
});

async function assertOwnedSession(id: string, userId: string) {
  const row = await prisma.session.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!row || row.userId !== userId) return null;
  return row;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: sessionId } = await ctx.params;
  const owned = await assertOwnedSession(sessionId, userId);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.bookmark.findMany({
    where: { sessionId },
    orderBy: { atMs: "asc" },
  });
  return NextResponse.json({ items: rows.map(toBookmarkDTO) });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: sessionId } = await ctx.params;
  const owned = await assertOwnedSession(sessionId, userId);
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  if (parsed.data.sessionId !== sessionId) {
    return NextResponse.json(
      { error: "sessionId in body does not match URL" },
      { status: 400 }
    );
  }

  const created = await prisma.bookmark.create({
    data: {
      sessionId,
      atMs: parsed.data.atMs,
      note: parsed.data.note ?? null,
    },
  });

  return NextResponse.json(toBookmarkDTO(created), { status: 201 });
}
