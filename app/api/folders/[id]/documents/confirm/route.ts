import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { toDocumentDTO } from "@/lib/api/dto";

const DocumentConfirmBodySchema = z.object({
  folderId: z.string().min(1),
  documentId: z.string().min(1),
  fileName: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().int().min(0),
  blobUrl: z.string().min(1),
  storageKey: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: folderId } = await params;

  let body: z.infer<typeof DocumentConfirmBodySchema>;
  try {
    const json = await req.json();
    body = DocumentConfirmBodySchema.parse(json);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request body" },
      { status: 400 }
    );
  }

  if (body.folderId !== folderId) {
    return NextResponse.json(
      { error: "folderId mismatch" },
      { status: 400 }
    );
  }

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, userId },
    select: { id: true },
  });
  if (!folder) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  const doc = await prisma.document.findFirst({
    where: { id: body.documentId, folderId },
    select: { id: true },
  });
  if (!doc) {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }

  const updated = await prisma.document.update({
    where: { id: body.documentId },
    data: {
      blobUrl: body.blobUrl,
      storageKey: body.storageKey,
      fileSize: body.fileSize,
      fileName: body.fileName,
      fileType: body.fileType,
    },
    include: { _count: { select: { extractedTerms: true } } },
  });

  return NextResponse.json(
    toDocumentDTO(updated, { termCount: updated._count.extractedTerms })
  );
}
