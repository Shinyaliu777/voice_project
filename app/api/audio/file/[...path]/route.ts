import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PREFIXES = ["audio/", "documents/", "chat-uploads/"];
const FINAL_AUDIO_RE = /^audio\/[^/]+\/final\.[A-Za-z0-9]+$/;

interface ParsedRange {
  start: number;
  end?: number;
}

/**
 * Parse an HTTP Range header of the form `bytes=START-END` (END optional).
 * Returns null when the header is missing or not parseable.
 */
function parseRange(header: string | null): ParsedRange | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const endRaw = match[2];
  const end = endRaw === "" ? undefined : Number(endRaw);
  if (!Number.isFinite(start)) return null;
  if (end !== undefined && !Number.isFinite(end)) return null;
  return { start, end };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  if (!path || path.length === 0) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }
  const key = path.join("/");
  if (!ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
    return NextResponse.json({ error: "Forbidden key" }, { status: 400 });
  }
  // Reject any path traversal attempt — keys must never reach above their prefix.
  if (key.includes("..")) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const rangeHeader = req.headers.get("range");
  const parsedRange = parseRange(rangeHeader);

  const { getStorageProvider } = await import("@/lib/storage");
  const storage = getStorageProvider();

  // First, determine total size by issuing a metadata-only fetch. The
  // StorageProvider contract returns `contentLength` on getStream(), so we
  // open a stream, read the metadata, then re-open with the actual range we
  // want (the local-fs driver is cheap to re-open). This keeps the contract
  // simple at the cost of a stat call.
  let probe;
  try {
    probe = await storage.getStream(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (/not found|enoent/i.test(message)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Storage error", details: message },
      { status: 502 }
    );
  }
  const total = probe.contentLength;
  const contentType = probe.contentType ?? "application/octet-stream";

  // Cancel the probe stream since we'll re-open it with a range when needed.
  try {
    await probe.body.cancel();
  } catch {
    // ignore
  }

  const cacheHeader = FINAL_AUDIO_RE.test(key)
    ? "public, max-age=3600"
    : "private, max-age=0";

  // No range: serve the whole thing as 200.
  if (!parsedRange) {
    const full = await storage.getStream(key);
    return new NextResponse(full.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheHeader,
      },
    });
  }

  // Validate the requested range against the known total.
  const start = parsedRange.start;
  const end = parsedRange.end !== undefined ? parsedRange.end : total - 1;

  const invalid =
    start < 0 ||
    start >= total ||
    end < start ||
    end >= total;

  if (invalid) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${total}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const partial = await storage.getStream(key, { start, end });
  const length = end - start + 1;
  return new NextResponse(partial.body, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(length),
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheHeader,
    },
  });
}
