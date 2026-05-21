/**
 * WebSocket server for live-share — bidirectional alternative to the existing
 * `host HTTP POST + viewer SSE` pair.
 *
 * Both transports coexist intentionally: the SSE/POST routes under
 * `app/api/live-share/[token]/...` stay in place for clients that can't or
 * don't want to upgrade. This module shares the same `broadcaster` pub/sub
 * backbone, so a message published over WS is delivered to SSE viewers and
 * vice-versa.
 *
 * Wire protocol
 * -------------
 *   ws://<host>/ws/live/:token?role=viewer
 *   ws://<host>/ws/live/:token?role=host
 *
 * Server -> client:
 *   - `{ type: "joined", session, segments }` once on viewer connect.
 *   - `{ type: "viewer-count", count }` whenever the viewer count changes,
 *     pushed to host and all viewers in the same room.
 *   - Any payload received from the broadcaster (utterance / segment /
 *     session-status / ...) forwarded verbatim to every viewer in the room.
 *
 * Client -> server (host only):
 *   - `{ type: "utterance" | "segment" | "session-status", ... }` → published
 *     to `broadcaster` for this token. Anything else is dropped.
 *
 * Auth
 * ----
 * The token is validated against `LiveShareSession`. Unknown tokens are
 * rejected with WS close code 4001 before any data is exchanged. Host role
 * is *not* checked against userId in this initial cut — same trust model as
 * the existing POST route relies on (the upload client knows the token).
 * Tighten later if needed; host POST already requires session cookie.
 */

import type http from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { prisma } from "@/lib/db";
import { toSegmentDTO, toSessionDTO } from "@/lib/api/dto";
import { broadcast, subscribe } from "@/lib/live-share/broadcaster";

const WS_PATH_PREFIX = "/ws/live/";

const VALID_HOST_MESSAGE_TYPES = new Set([
  "utterance",
  "segment",
  "session-status",
]);

interface Room {
  viewers: Set<WebSocket>;
  host: WebSocket | null;
}

// Module-scoped room registry. We keep it on globalThis so the dev server's
// HMR can't accidentally fork it.
const globalKey = "__voice_live_share_ws_rooms__" as const;
interface RoomStore {
  [globalKey]?: Map<string, Room>;
}

function getRooms(): Map<string, Room> {
  const g = globalThis as unknown as RoomStore;
  if (!g[globalKey]) g[globalKey] = new Map();
  return g[globalKey]!;
}

function getOrCreateRoom(token: string): Room {
  const rooms = getRooms();
  let room = rooms.get(token);
  if (!room) {
    room = { viewers: new Set(), host: null };
    rooms.set(token, room);
  }
  return room;
}

function broadcastViewerCount(token: string, room: Room): void {
  const msg = JSON.stringify({ type: "viewer-count", count: room.viewers.size });
  for (const ws of room.viewers) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
      } catch {
        /* ignore individual viewer failures */
      }
    }
  }
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    try {
      room.host.send(msg);
    } catch {
      /* ignore */
    }
  }
}

function parseRequestUrl(req: http.IncomingMessage): {
  token: string | null;
  role: "host" | "viewer";
} {
  const host = req.headers.host ?? "localhost";
  let url: URL;
  try {
    url = new URL(req.url ?? "", `http://${host}`);
  } catch {
    return { token: null, role: "viewer" };
  }
  if (!url.pathname.startsWith(WS_PATH_PREFIX)) {
    return { token: null, role: "viewer" };
  }
  const token = url.pathname.slice(WS_PATH_PREFIX.length);
  if (!token) return { token: null, role: "viewer" };
  const roleParam = url.searchParams.get("role");
  const role = roleParam === "host" ? "host" : "viewer";
  return { token, role };
}

async function handleViewerConnect(
  ws: WebSocket,
  token: string,
  room: Room
): Promise<void> {
  // Initial snapshot — mirrors what the SSE route emits as the `joined` event.
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
    // Race: token vanished between auth check and now. Close politely.
    ws.close(4001, "Token not found");
    return;
  }

  const sessionRow = share.session;
  const sessionDTO = toSessionDTO(sessionRow, {
    segmentCount: sessionRow.segments.length,
  });
  const segments = sessionRow.segments.map(toSegmentDTO);

  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(
        JSON.stringify({ type: "joined", session: sessionDTO, segments })
      );
    } catch {
      // If the very first send fails, give up on this connection.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
  }

  // Subscribe to broadcaster fan-out. This bridges WS viewers with any source
  // of events — including the existing HTTP POST route and other WS hosts.
  const unsubscribe = subscribe(token, (payload) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* drop on next close handler */
    }
  });

  ws.on("close", () => {
    unsubscribe();
    room.viewers.delete(ws);
    // If the room is now empty and host is also gone, prune it so we don't
    // leak a map entry for every token ever connected.
    if (room.viewers.size === 0 && !room.host) {
      getRooms().delete(token);
    } else {
      broadcastViewerCount(token, room);
    }
  });

  ws.on("error", () => {
    // Let `close` handle cleanup; ws emits close after error.
  });

  // Announce arrival to the rest of the room.
  broadcastViewerCount(token, room);
}

function handleHostConnect(
  ws: WebSocket,
  token: string,
  room: Room
): void {
  // Multiple host connects are tolerated: the latest wins. A real product
  // might want stricter semantics; this is intentionally forgiving so a
  // reconnect attempt doesn't fight the previous (likely-dead) socket.
  if (room.host && room.host !== ws) {
    try {
      room.host.close(4002, "Replaced by new host connection");
    } catch {
      /* ignore */
    }
  }
  room.host = ws;

  ws.on("message", (raw: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    if (!parsed || typeof parsed !== "object") return;
    const rec = parsed as { type?: unknown };
    if (typeof rec.type !== "string") return;
    if (!VALID_HOST_MESSAGE_TYPES.has(rec.type)) return;
    broadcast(token, rec as object);
  });

  ws.on("close", () => {
    // Don't broadcast anything — host reconnects are common (page refresh,
    // network blip) and a flicker on viewers is more annoying than useful.
    if (room.host === ws) {
      room.host = null;
    }
    if (room.viewers.size === 0 && !room.host) {
      getRooms().delete(token);
    }
  });

  ws.on("error", () => {
    /* close handler does cleanup */
  });
}

/**
 * Attach a `/ws/live/:token` upgrade handler to the given HTTP server.
 *
 * Called once from `server.ts` after the Next.js handler is installed. Any
 * upgrade request whose path doesn't match the WS prefix is left alone so
 * other upgrade handlers (none today, but keeps the door open) can claim it.
 */
export function attachLiveShareWs(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const { token, role } = parseRequestUrl(req);
    if (!token) {
      // Not ours; leave the socket alone. If nobody else picks it up the
      // client will time out — that's fine for upgrade requests.
      return;
    }

    // Auth: token must resolve to an existing LiveShareSession. We can't
    // easily check "active" because the schema has no such column today;
    // existence is the contract that matches the SSE/POST routes.
    let exists = false;
    try {
      const share = await prisma.liveShareSession.findUnique({
        where: { token },
        select: { id: true },
      });
      exists = Boolean(share);
    } catch (err) {
      console.warn(
        "[live-share-ws] token lookup failed:",
        err instanceof Error ? err.message : String(err)
      );
    }

    if (!exists) {
      // Per RFC6455 we should reject with HTTP, but the ws library wants us
      // to either accept or destroy. Easiest: accept and immediately close
      // with a custom code so the client sees a structured failure.
      wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          ws.close(4001, "Token not found");
        } catch {
          /* ignore */
        }
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = getOrCreateRoom(token);
      if (role === "host") {
        handleHostConnect(ws, token, room);
      } else {
        room.viewers.add(ws);
        // Fire-and-forget the snapshot send; viewer is already attached.
        handleViewerConnect(ws, token, room).catch((err) => {
          console.warn(
            "[live-share-ws] viewer setup failed:",
            err instanceof Error ? err.message : String(err)
          );
        });
      }
    });
  });
}
