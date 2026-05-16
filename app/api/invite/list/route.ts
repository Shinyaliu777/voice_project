import { NextResponse } from "next/server";

import { getDevUserId } from "@/lib/dev-user";

/**
 * Phase-1 invite stub.
 *
 * The real flow will track per-user invitations, attribute first-recordings,
 * and credit minutes. For now we return a deterministic code derived from
 * the user's id so the UI can render and the user can copy something stable,
 * plus hardcoded 0 / 1500-cap counters.
 */
export async function GET() {
  const userId = await getDevUserId();
  const inviteCode = userId.slice(0, 5).toUpperCase();

  return NextResponse.json({
    inviteCode,
    invitedCount: 0,
    earnedMinutes: 0,
    maxMinutes: 1500,
  });
}
