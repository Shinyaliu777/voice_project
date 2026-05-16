import { type NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { toSegmentDTO, toSessionDTO } from "@/lib/api/dto";
import { subscribe } from "@/lib/live-share/broadcaster";

// SSE responses must not be buffered or cached by Next's edge layer.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public SSE feed. No auth — anyone with the token can read.
 *
 * On connect we emit one `joined` event containing the session DTO and any
 * existing finalized segments. Subsequent events come from the host pushing
 * via /api/live-share/{token}/push.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;

  const share = await prisma.liveShareSession.findUnique({
    where: { token },
    include: {
      session: {
        include: {
          segments: { orderBy: { segmentIndex: "asc" } },
        },
      },
    },
  });
  if (!share) {
    return new Response("Not found", { status: 404 });
  }

  const sessionRow = share.session;
  const sessionDTO = toSessionDTO(sessionRow, {
    segmentCount: sessionRow.segments.length,
  });
  const segments = sessionRow.segments.map(toSegmentDTO);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        const payload =
          `event: ${event}\n` +
          `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      // First, initial replay so viewers don't have to wait for the next
      // utterance to see anything.
      send("joined", { session: sessionDTO, segments });

      const unsubscribe = subscribe(token, (payload) => {
        // Look up `type` to choose the SSE event name; fall back to "message".
        const rec = payload as { type?: string };
        const evt =
          typeof rec.type === "string" && rec.type.length > 0
            ? rec.type
            : "message";
        send(evt, payload);
      });

      // Heartbeat keeps proxies from closing the connection idle.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Wire abort signal so the connection drops cleanly when the viewer
      // closes the tab.
      const signal = _req.signal;
      if (signal.aborted) {
        cleanup();
      } else {
        signal.addEventListener("abort", cleanup, { once: true });
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
