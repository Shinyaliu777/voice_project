import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toExtractedTermDTO } from "@/lib/api/dto";
import type { ExtractedTermDTO } from "@/lib/contracts";

/**
 * Response shape: each document the dev user owns (via its folder), with its
 * extracted terms inlined. The client groups by document for display.
 */
export interface ExtractedTermsListItem {
  documentId: string;
  folderId: string;
  fileName: string;
  terms: ExtractedTermDTO[];
}

export interface ExtractedTermsListResponse {
  items: ExtractedTermsListItem[];
}

export async function GET() {
  const userId = await getDevUserId();

  // Join: Document -> Folder.userId == dev user.
  const docs = await prisma.document.findMany({
    where: { folder: { userId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      folderId: true,
      fileName: true,
      extractedTerms: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const items: ExtractedTermsListItem[] = docs.map((d) => ({
    documentId: d.id,
    folderId: d.folderId,
    fileName: d.fileName,
    terms: d.extractedTerms.map(toExtractedTermDTO),
  }));

  const body: ExtractedTermsListResponse = { items };
  return NextResponse.json(body);
}
