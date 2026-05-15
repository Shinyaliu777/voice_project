import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toSessionDTO } from "@/lib/api/dto";
import {
  SUPPORTED_LANGUAGES,
  type PaginatedResponse,
  type SessionDTO,
} from "@/lib/contracts";

const SESSION_STATUSES = [
  "idle",
  "recording",
  "uploading",
  "ready",
  "error",
] as const;

const langSchema = z.string().min(2).max(16);

const listQuerySchema = z.object({
  folderId: z.string().optional(),
  status: z.union([z.enum(SESSION_STATUSES), z.literal("all")]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const createBodySchema = z.object({
  title: z.string().max(200).optional(),
  folderId: z.string().nullish(),
  sourceLang: langSchema,
  targetLang: langSchema,
});

export async function GET(req: NextRequest) {
  const userId = await getDevUserId();
  const url = new URL(req.url);
  const parsed = listQuerySchema.safeParse({
    folderId: url.searchParams.get("folderId") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { folderId, status, limit = 20, cursor } = parsed.data;

  const where: {
    userId: string;
    folderId?: string | null;
    status?: string;
  } = { userId };

  if (folderId === "unfiled") {
    where.folderId = null;
  } else if (folderId) {
    // verify folder belongs to dev user; otherwise return empty
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
      select: { userId: true },
    });
    if (!folder || folder.userId !== userId) {
      const empty: PaginatedResponse<SessionDTO> = {
        items: [],
        total: 0,
        cursor: null,
      };
      return NextResponse.json(empty);
    }
    where.folderId = folderId;
  }
  if (status && status !== "all") where.status = status;

  const total = await prisma.session.count({ where });

  const rows = await prisma.session.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      _count: { select: { segments: true } },
      minutes: { select: { id: true } },
    },
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  const items = slice.map((r) =>
    toSessionDTO(r, {
      segmentCount: r._count.segments,
      hasMinutes: !!r.minutes,
      audioUrl: r.audioPath ? `/api/audio/file/${r.audioPath}` : null,
    })
  );

  const resp: PaginatedResponse<SessionDTO> = {
    items,
    total,
    cursor: hasMore ? slice[slice.length - 1].id : null,
  };
  return NextResponse.json(resp);
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
  const { title, folderId, sourceLang, targetLang } = parsed.data;

  if (folderId) {
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
      select: { userId: true },
    });
    if (!folder || folder.userId !== userId) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
  }

  const session = await prisma.session.create({
    data: {
      userId,
      folderId: folderId ?? null,
      title: title ?? "",
      sourceLang,
      targetLang,
      status: "idle",
    },
    include: {
      _count: { select: { segments: true } },
      minutes: { select: { id: true } },
    },
  });

  // Lint hint: SUPPORTED_LANGUAGES kept imported so future schemas can enum it.
  void SUPPORTED_LANGUAGES;

  return NextResponse.json(
    toSessionDTO(session, {
      segmentCount: session._count.segments,
      hasMinutes: !!session.minutes,
      audioUrl: session.audioPath ? `/api/audio/file/${session.audioPath}` : null,
    }),
    { status: 201 }
  );
}
