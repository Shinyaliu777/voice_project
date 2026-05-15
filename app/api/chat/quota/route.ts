import { NextResponse } from "next/server";
import { getDevUserId } from "@/lib/dev-user";

export async function GET() {
  await getDevUserId();
  // Phase 1 stub — real per-user quota tracking is a follow-up.
  return NextResponse.json({
    remaining: 1000,
    used: 0,
    limit: 1000,
  });
}
