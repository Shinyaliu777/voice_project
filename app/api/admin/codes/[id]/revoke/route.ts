import { NextResponse, type NextRequest } from "next/server";

import { withAdmin } from "@/lib/admin-route";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/codes/[id]/revoke
 *
 * Soft-disable a redemption code. Past redemptions (and the minutes
 * they granted) are preserved — this only prevents future redeems.
 */
export const POST = withAdmin(
  async (
    _adminId,
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;
    const code = await prisma.redemptionCode.findUnique({ where: { id } });
    if (!code) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!code.isActive) {
      return NextResponse.json({ ok: true, alreadyRevoked: true });
    }
    await prisma.redemptionCode.update({
      where: { id },
      data: { isActive: false },
    });
    return NextResponse.json({ ok: true });
  }
);
