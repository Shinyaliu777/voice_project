import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { withAdmin } from "@/lib/admin-route";
import {
  canonicalizeCode,
  formatCodeForDisplay,
  generateCode,
} from "@/lib/billing";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/codes
 *
 * Paginated list of redemption codes the admin team has issued.
 * Default sort: newest first.
 */
export const GET = withAdmin(async (_adminId, req: NextRequest) => {
  const url = new URL(req.url);
  const take = Math.min(
    Math.max(parseInt(url.searchParams.get("take") ?? "50", 10) || 50, 1),
    200
  );
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const onlyActive = url.searchParams.get("active") === "1";

  const where = onlyActive ? { isActive: true } : undefined;

  const rows = await prisma.redemptionCode.findMany({
    where,
    take: take + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      createdBy: { select: { email: true, name: true } },
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return NextResponse.json({
    codes: page.map((c) => ({
      id: c.id,
      code: c.code,
      codeDisplay: formatCodeForDisplay(c.code),
      minutes: c.minutes,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      remainingUses: Math.max(0, c.maxUses - c.usedCount),
      isActive: c.isActive,
      expiresAt: c.expiresAt,
      note: c.note,
      createdAt: c.createdAt,
      createdBy: c.createdBy,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  });
});

/**
 * POST /api/admin/codes
 *
 * Mint a new redemption code. Body:
 *   {
 *     minutes:   required, positive, <= 1_000_000
 *     maxUses:   default 1, <= 10_000
 *     expiresAt: optional ISO date
 *     note:      optional human-readable label
 *     prefix:    optional code prefix, default "GIFT"
 *     code:      optional custom code (canonicalized server-side)
 *   }
 *
 * Returns the generated/normalized code with display formatting.
 */
const createBody = z
  .object({
    minutes: z.number().int().positive().max(1_000_000),
    maxUses: z.number().int().positive().max(10_000).default(1),
    expiresAt: z.string().datetime().nullish(),
    note: z.string().max(500).nullish(),
    prefix: z
      .string()
      .max(8)
      .regex(/^[A-Za-z0-9]*$/, "Prefix must be alphanumeric")
      .optional(),
    code: z.string().min(4).max(40).optional(),
  })
  .strict();

export const POST = withAdmin(async (adminId, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const canonical = parsed.data.code
    ? canonicalizeCode(parsed.data.code)
    : generateCode(parsed.data.prefix ?? "GIFT");
  if (!canonical || canonical.length < 4) {
    return NextResponse.json(
      { error: "Code too short after canonicalization" },
      { status: 400 }
    );
  }

  try {
    const row = await prisma.redemptionCode.create({
      data: {
        code: canonical,
        minutes: parsed.data.minutes,
        maxUses: parsed.data.maxUses,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        note: parsed.data.note ?? null,
        createdById: adminId,
      },
    });
    return NextResponse.json({
      id: row.id,
      code: row.code,
      codeDisplay: formatCodeForDisplay(row.code),
      minutes: row.minutes,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      isActive: row.isActive,
      expiresAt: row.expiresAt,
      note: row.note,
      createdAt: row.createdAt,
    });
  } catch (err) {
    // P2002 = unique constraint on `code` — collision is astronomically
    // unlikely with the 8-char random alphabet but we surface a clean
    // error anyway so the admin can retry instead of seeing a 500.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Code already exists, try again" },
        { status: 409 }
      );
    }
    throw err;
  }
});
