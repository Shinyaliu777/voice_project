import { NextResponse } from "next/server";

import { UnauthenticatedError, getDevUserId } from "@/lib/dev-user";
import { getQuota } from "@/lib/quota";

/**
 * GET /api/chat/quota
 *
 * Returns the chat-daily quota for the current user plus the model menu
 * the UI can present. Premium models are gated client-side using
 * `isPremium` + `isPaidUser` (derived from the user's plan).
 *
 * Response shape mirrors lecsync's so the same UI components can read it.
 */
export async function GET() {
  let userId: string;
  try {
    userId = await getDevUserId();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  const info = await getQuota(userId, "chat");
  const isPaidUser = info.planName.toLowerCase() !== "free";

  // Hard-coded model menu for now — when Stripe billing lands, move to a
  // DB table so admins can flip the premium flag without a redeploy.
  const models = [
    {
      modelId: "deepseek-v4-flash",
      displayName: "Basic",
      isPremium: false,
      supportsThinking: true,
      supportsWebSearch: false, // pending — see docs/FUTURE_FEATURES.md
    },
    {
      modelId: "deepseek-v4-pro",
      displayName: "Pro",
      isPremium: true,
      supportsThinking: true,
      supportsWebSearch: false,
    },
  ];

  return NextResponse.json({
    models,
    isPaidUser,
    planName: info.planName,
    dailyUsed: info.used,
    dailyLimit: info.limit, // 0 = unlimited
    defaultModelId: "deepseek-v4-flash",
  });
}
