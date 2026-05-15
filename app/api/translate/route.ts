import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getServerTranslationProvider } from "@/lib/translation";
import type { TranslateResp } from "@/lib/contracts";

const TranslateBodySchema = z.object({
  text: z.string().min(1),
  sourceLanguage: z.string().min(1),
  targetLanguage: z.string().min(1),
  terms: z
    .array(
      z.object({
        term: z.string().min(1),
        definition: z.string().optional(),
      })
    )
    .optional(),
  segmentId: z.string().optional(),
});

export async function POST(req: Request) {
  await getDevUserId();

  let parsed;
  try {
    const json = await req.json();
    parsed = TranslateBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  const provider = getServerTranslationProvider("cloud");
  const result = await provider.translate({
    text: parsed.text,
    sourceLanguage: parsed.sourceLanguage,
    targetLanguage: parsed.targetLanguage,
    terms: parsed.terms,
    segmentId: parsed.segmentId,
  });

  if (parsed.segmentId) {
    try {
      await prisma.segment.update({
        where: { id: parsed.segmentId },
        data: { translatedText: result.translatedText },
      });
    } catch {
      // best-effort; swallow errors
    }
  }

  const resp: TranslateResp = {
    translatedText: result.translatedText,
    translationSource: result.translationSource,
    segmentId: parsed.segmentId,
  };

  return NextResponse.json(resp);
}
