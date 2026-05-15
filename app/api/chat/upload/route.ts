import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";

function extFromFileName(name: string, fallback: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return fallback;
  return name.slice(dot + 1).toLowerCase();
}

function extFromContentType(ct: string): string {
  if (!ct) return "bin";
  const mapping: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/markdown": "md",
    "application/json": "json",
    "application/zip": "zip",
  };
  return mapping[ct.toLowerCase()] ?? "bin";
}

export async function POST(req: Request) {
  const userId = await getDevUserId();

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid form data" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: "Missing 'file' in form data" },
      { status: 400 }
    );
  }

  const fileName =
    file instanceof File && file.name ? file.name : "upload.bin";
  const contentType =
    (file.type && file.type.length > 0 ? file.type : "application/octet-stream") || "application/octet-stream";
  const ext =
    extFromFileName(fileName, extFromContentType(contentType)) || "bin";

  const id = crypto.randomUUID();
  const key = `chat-uploads/${userId}/${id}.${ext}`;

  const storage = getStorageProvider();
  const arr = new Uint8Array(await file.arrayBuffer());
  const { publicUrl } = await storage.putStream(key, arr, contentType);

  return NextResponse.json({
    url: publicUrl,
    fileName,
    fileSize: arr.byteLength,
    contentType,
  });
}
