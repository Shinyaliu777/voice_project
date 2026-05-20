import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { toSegmentDTO } from "@/lib/api/dto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public read-only segment list scoped to a live-share token. Used by the
 * viewer to reconcile its SSE-driven state against the persisted truth — if
 * any utterance/segment push from the host got dropped (network blip,
 * fire-and-forget failure, nginx 502, etc.) the viewer's 30 s polling tick
 * still recovers those segments. Pairs with the host-side push retry to
 * give live-share two independent paths to converge.
 *
 * Token-scoped — no user auth. Same threat model as the SSE route at
 * /api/live-share/[token].
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;

  const share = await prisma.liveShareSession.findUnique({
    where: { token },
    include: {
      session: {
        include: {
          segments: { orderBy: { segmentIndex: "asc" } },
        },
      },
    },
  });
  if (!share) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    items: share.session.segments.map(toSegmentDTO),
  });
}
