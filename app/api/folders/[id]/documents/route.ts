import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";
import { toDocumentDTO } from "@/lib/api/dto";
import type { DocumentPresignResponse } from "@/lib/contracts";

const DocumentPresignBodySchema = z.object({
  folderId: z.string().min(1),
  fileName: z.string().min(1),
  fileType: z.string().min(1),
  fileSize: z.number().int().min(0),
});

function extFromFileName(name: string, fallback: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return fallback;
  return name.slice(dot + 1).toLowerCase();
}

function extFromMime(ct: string): string {
  const m: Record<string, string> = {
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "pptx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/json": "json",
  };
  return m[ct.toLowerCase()] ?? "bin";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: folderId } = await params;

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, userId },
    select: { id: true },
  });
  if (!folder) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  const docs = await prisma.document.findMany({
    where: { folderId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { extractedTerms: true } } },
  });

  return NextResponse.json({
    items: docs.map((d) =>
      toDocumentDTO(d, { termCount: d._count.extractedTerms })
    ),
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id: folderId } = await params;

  let body: z.infer<typeof DocumentPresignBodySchema>;
  try {
    const json = await req.json();
    body = DocumentPresignBodySchema.parse(json);
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

  const doc = await prisma.document.create({
    data: {
      folderId,
      fileName: body.fileName,
      fileType: body.fileType,
      fileSize: body.fileSize,
      storageKey: "",
      blobUrl: "",
      extractionStatus: "pending",
    },
  });

  const ext =
    extFromFileName(body.fileName, extFromMime(body.fileType)) || "bin";
  const storage = getStorageProvider();
  const storageKey = storage.keyForFolderDocument(folderId, doc.id, ext);

  await prisma.document.update({
    where: { id: doc.id },
    data: { storageKey },
  });

  const presign = await storage.presignPut({
    key: storageKey,
    contentType: body.fileType,
    sizeBytes: body.fileSize,
  });

  const resp: DocumentPresignResponse = {
    uploadUrl: presign.uploadUrl,
    publicUrl: presign.publicUrl,
    method: presign.method,
    headers: presign.headers,
    documentId: doc.id,
    storageKey,
  };
  return NextResponse.json(resp, { status: 201 });
}
