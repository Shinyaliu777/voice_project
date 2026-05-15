import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  const userId = await getDevUserId();
  const { id: folderId, docId } = await params;

  const folder = await prisma.folder.findFirst({
    where: { id: folderId, userId },
    select: { id: true },
  });
  if (!folder) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  const doc = await prisma.document.findFirst({
    where: { id: docId, folderId },
    select: { id: true, storageKey: true },
  });
  if (!doc) {
    return NextResponse.json(
      { error: "Document not found" },
      { status: 404 }
    );
  }

  if (doc.storageKey) {
    try {
      await getStorageProvider().delete(doc.storageKey);
    } catch {
      // ignore storage errors per spec
    }
  }

  await prisma.document.delete({ where: { id: docId } });
  return NextResponse.json({ ok: true });
}
