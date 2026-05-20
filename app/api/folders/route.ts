import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toFolderDTO } from "@/lib/api/dto";

const langSchema = z.string().min(2).max(16);

const createBodySchema = z.object({
  name: z.string().min(1).max(120),
  // `.nullish()` matches the PATCH schema in [id]/route.ts so clients
  // can send `color: null` (used for the "灰" / default option in
  // CreateFolderCard's palette) without hitting a 400. Without this
  // the POST silently failed for any folder created via the default
  // color picker.
  color: z.string().max(32).nullish(),
  sourceLang: langSchema.nullish(),
  targetLang: langSchema.nullish(),
});

export async function GET() {
  const userId = await getDevUserId();
  const rows = await prisma.folder.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { sessions: true, documents: true } },
    },
  });
  const items = rows.map((r) =>
    toFolderDTO(r, {
      sessionCount: r._count.sessions,
      documentCount: r._count.documents,
    })
  );
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

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
  const { name, color, sourceLang, targetLang } = parsed.data;

  // Surface a clean 409 when the user already has a folder of the same
  // name. There's no DB-level @@unique on (userId, name) yet — adding
  // one would require a migration that could fail on existing dup data
  // — so we do an explicit lookup. CreateFolderCard expects this 409
  // shape; without it, creating a duplicate silently succeeded and the
  // toast said "已创建" while showing two folders side-by-side.
  const existingDup = await prisma.folder.findFirst({
    where: { userId, name },
    select: { id: true },
  });
  if (existingDup) {
    return NextResponse.json(
      { error: "Folder with this name already exists" },
      { status: 409 }
    );
  }

  const folder = await prisma.folder.create({
    data: {
      userId,
      name,
      color: color ?? null,
      sourceLang: sourceLang ?? null,
      targetLang: targetLang ?? null,
    },
    include: {
      _count: { select: { sessions: true, documents: true } },
    },
  });

  return NextResponse.json(
    toFolderDTO(folder, {
      sessionCount: folder._count.sessions,
      documentCount: folder._count.documents,
    }),
    { status: 201 }
  );
}
