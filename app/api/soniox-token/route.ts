import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getDevUserId } from "@/lib/dev-user";
import type { SonioxTokenResp } from "@/lib/contracts";

const bodySchema = z
  .object({
    expiresInSeconds: z.number().int().min(30).max(86_400).optional(),
    clientReferenceId: z.string().max(200).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const userId = await getDevUserId();

  // Body is optional for this route (all fields optional).
  let body: unknown = {};
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    try {
      body = await req.json();
    } catch {
      // tolerate empty / non-JSON
      body = {};
    }
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Lazy import so missing provider env doesn't crash route module load.
  const { getASRProvider } = await import("@/lib/asr");
  const provider = getASRProvider();

  try {
    const token = await provider.mintTemporaryToken({
      expiresInSeconds: parsed.data.expiresInSeconds,
      clientReferenceId: parsed.data.clientReferenceId ?? userId,
    });
    const resp: SonioxTokenResp = token;
    return NextResponse.json(resp);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to mint token", details: message },
      { status: 502 }
    );
  }
}
