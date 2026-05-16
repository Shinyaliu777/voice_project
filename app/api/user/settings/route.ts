import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";

/**
 * Per-user UI settings. Everything is optional — the client only sends the
 * keys it wants to change and the server shallow-merges into the existing
 * JSON blob on the User row.
 *
 * Phase 1: scoped to the dev user. When real auth lands we'll swap
 * getDevUserId() for the session user.
 */
const settingsSchema = z
  .object({
    // 通用
    defaultSourceLang: z.string().min(2).max(16).optional(),
    defaultTargetLang: z.string().min(2).max(16).optional(),
    contentLang: z.string().min(2).max(16).optional(),

    // 样式
    theme: z.enum(["system", "light", "dark"]).optional(),
    fontSize: z.number().int().min(10).max(28).optional(),

    // 通知
    emailNotifications: z.boolean().optional(),
    desktopNotifications: z.boolean().optional(),

    // 悬浮窗
    floatingShowTranslation: z.boolean().optional(),
    floatingFontSize: z.number().int().min(10).max(48).optional(),
    floatingWindowWidth: z.number().int().min(240).max(960).optional(),
    floatingMaxHistoryItems: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export type UserSettingsPatch = z.infer<typeof settingsSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET() {
  const userId = await getDevUserId();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const raw = user?.settings;
  const settings = isPlainObject(raw) ? raw : null;
  return NextResponse.json({ settings });
}

export async function PATCH(req: NextRequest) {
  const userId = await getDevUserId();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const prev = isPlainObject(existing?.settings) ? existing!.settings : {};
  const merged: Record<string, unknown> = { ...prev, ...parsed.data };

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { settings: merged as Prisma.InputJsonValue },
    select: { settings: true },
  });

  const next = isPlainObject(updated.settings) ? updated.settings : null;
  return NextResponse.json({ settings: next });
}
