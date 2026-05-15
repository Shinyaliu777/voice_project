/**
 * Local-filesystem implementation of StorageProvider.
 *
 * Phase 1 stores everything on disk. The "presign" call returns a route
 * inside this app (PUT /api/audio/upload-chunk?key=...) that the chunk
 * uploader hits with the raw bytes; that route is expected to call
 * `putStream` on this same provider.
 */
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import type {
  StorageGetRange,
  StorageGetResponse,
  StoragePresignRequest,
  StoragePresignResponse,
  StorageProvider,
} from "../contracts";

const DEFAULT_ROOT = "./uploads";
const DEFAULT_PUBLIC_BASE = "/api/audio/file";

const EXT_CONTENT_TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  wav: "audio/wav",
  opus: "audio/opus",
  aac: "audio/aac",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
};

function inferContentTypeFromKey(key: string): string {
  const idx = key.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = key.slice(idx + 1).toLowerCase();
  return EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export class LocalFsStorage implements StorageProvider {
  private readonly rootDir: string;
  private readonly publicBase: string;

  constructor() {
    this.rootDir = path.resolve(
      process.env.STORAGE_LOCAL_DIR ?? DEFAULT_ROOT
    );
    this.publicBase = process.env.STORAGE_PUBLIC_BASE ?? DEFAULT_PUBLIC_BASE;
  }

  // ---------- key builders ----------

  keyForChunk(sessionId: string, chunkIndex: number, ext: string): string {
    return `audio/${sessionId}/chunks/${String(chunkIndex).padStart(6, "0")}.${ext}`;
  }

  keyForFinalAudio(sessionId: string, ext: string): string {
    return `audio/${sessionId}/final.${ext}`;
  }

  keyForFolderDocument(folderId: string, docId: string, ext: string): string {
    return `documents/${folderId}/${docId}.${ext}`;
  }

  publicUrlFor(key: string): string {
    const encoded = key
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const base = this.publicBase.endsWith("/")
      ? this.publicBase.slice(0, -1)
      : this.publicBase;
    const tail = encoded.startsWith("/") ? encoded.slice(1) : encoded;
    return `${base}/${tail}`;
  }

  // ---------- presign / put ----------

  async presignPut(
    req: StoragePresignRequest
  ): Promise<StoragePresignResponse> {
    return {
      uploadUrl: `/api/audio/upload-chunk?key=${encodeURIComponent(req.key)}`,
      publicUrl: this.publicUrlFor(req.key),
      method: "PUT",
      headers: { "Content-Type": req.contentType },
    };
  }

  async putStream(
    key: string,
    body: WebReadableStream<Uint8Array> | ReadableStream<Uint8Array> | Buffer | Uint8Array,
    _contentType: string
  ): Promise<{ publicUrl: string }> {
    const absPath = this.resolveAndGuard(key);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    if (Buffer.isBuffer(body)) {
      await fs.writeFile(absPath, body);
    } else if (body instanceof Uint8Array) {
      await fs.writeFile(absPath, body);
    } else {
      // Web ReadableStream → Node stream → file
      const nodeStream = Readable.fromWeb(body as WebReadableStream<Uint8Array>);
      const writeStream = createWriteStream(absPath);
      await pipeline(nodeStream, writeStream);
    }

    return { publicUrl: this.publicUrlFor(key) };
  }

  // ---------- get ----------

  async getStream(
    key: string,
    range?: StorageGetRange
  ): Promise<StorageGetResponse> {
    const absPath = this.resolveAndGuard(key);
    const stat = await fs.stat(absPath);

    let start = 0;
    let end = stat.size - 1;
    if (range) {
      start = Math.max(0, range.start);
      end = Math.min(stat.size - 1, range.end);
      if (end < start) {
        throw new Error(
          `Invalid range for ${key}: ${range.start}-${range.end} (size=${stat.size})`
        );
      }
    }
    const contentLength = end - start + 1;
    const readStream = createReadStream(absPath, { start, end });
    return {
      body: Readable.toWeb(readStream) as ReadableStream<Uint8Array>,
      contentLength,
      contentType: inferContentTypeFromKey(key),
    };
  }

  async exists(key: string): Promise<boolean> {
    const absPath = this.resolveAndGuard(key);
    try {
      await fs.access(absPath);
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const absPath = this.resolveAndGuard(key);
    try {
      await fs.unlink(absPath);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  // ---------- internals ----------

  /**
   * Resolve `key` under rootDir and reject anything that would escape it
   * (e.g. "../../etc/passwd"). All callers must go through this.
   */
  private resolveAndGuard(key: string): string {
    const normalized = key.replace(/^\/+/, "");
    const abs = path.resolve(this.rootDir, normalized);
    const rootWithSep = this.rootDir.endsWith(path.sep)
      ? this.rootDir
      : this.rootDir + path.sep;
    if (abs !== this.rootDir && !abs.startsWith(rootWithSep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return abs;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
