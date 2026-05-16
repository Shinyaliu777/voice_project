import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getDevUserId } from "@/lib/dev-user";
import { getStorageProvider } from "@/lib/storage";
import { generateSessionWordDoc } from "@/lib/export/word";
import { toMinutesDTO, toSegmentDTO } from "@/lib/api/dto";

const ALLOWED = new Set(["docx", "pdf", "audio"] as const);
type Format = "docx" | "pdf" | "audio";

function slugify(s: string): string {
  const ascii = (s || "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return ascii.slice(0, 80) || "recording";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getDevUserId();
  const { id } = await params;
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "docx").toLowerCase();
  if (!ALLOWED.has(format as Format)) {
    return NextResponse.json(
      { error: `Unsupported format "${format}". Use docx, pdf, or audio.` },
      { status: 400 }
    );
  }

  const session = await prisma.session.findUnique({
    where: { id },
    include: {
      segments: { orderBy: { segmentIndex: "asc" } },
      speakerNames: true,
      minutes: true,
    },
  });
  if (!session || session.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baseName = slugify(session.title || "recording");

  if (format === "audio") {
    if (!session.audioPath) {
      return NextResponse.json({ error: "No audio yet" }, { status: 404 });
    }
    const storage = getStorageProvider();
    const got = await storage.getStream(session.audioPath);
    const ext =
      session.audioContentType?.includes("webm") ? "webm"
      : session.audioContentType?.includes("mp4") ? "m4a"
      : session.audioContentType?.includes("ogg") ? "ogg"
      : "audio";
    return new Response(got.body, {
      headers: {
        "Content-Type": got.contentType ?? session.audioContentType ?? "audio/webm",
        "Content-Length": String(got.contentLength),
        "Content-Disposition": `attachment; filename="${baseName}.${ext}"`,
        "Cache-Control": "private, max-age=0",
      },
    });
  }

  if (format === "docx") {
    const minutes = session.minutes ? toMinutesDTO(session.minutes) : null;
    const segments = session.segments.map(toSegmentDTO);
    const buffer = await generateSessionWordDoc(
      session,
      segments,
      session.speakerNames,
      minutes
    );
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `attachment; filename="${baseName}.docx"`,
        "Cache-Control": "private, max-age=0",
      },
    });
  }

  // format === "pdf"
  return NextResponse.json(
    {
      error:
        "PDF export needs a registered CJK font (思源黑体/Noto Sans CJK) before pdfkit can render Chinese. Use Word export for now.",
    },
    { status: 501 }
  );
}
