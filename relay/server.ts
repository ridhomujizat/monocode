// Splice relay: one host socket and N client sockets per hostId, frames copied
// between them. The relay reads `v` and `to` only — `body` is never inspected
// or logged (ADR 0001).
//
// No auth and no persistence in this task: tokens, pairing and the SQLite
// tables land in T6, and the Caddy front door in T5.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const MAX_FRAME = 1024 * 1024; // 1 MB per frame (diagram 03)
const MAX_BUFFER = 8 * 1024 * 1024; // 8 MB queued per client, then 1013
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_PATH = /^\/ws\/c\/(.*)$/;

type Room = { host: WebSocket | null; clients: Map<string, WebSocket> };
type Frame = { v?: unknown; to?: unknown; id?: unknown };

export function createRelay(): Server {
  const rooms = new Map<string, Room>();

  const roomFor = (hostId: string): Room => {
    let room = rooms.get(hostId);
    if (!room) {
      room = { host: null, clients: new Map() };
      rooms.set(hostId, room);
    }
    return room;
  };

  const forget = (hostId: string, room: Room) => {
    if (!room.host && room.clients.size === 0) rooms.delete(hostId);
  };

  const send = (ws: WebSocket, frame: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  /// Envelope only: size, `v`, and the raw text to forward. A frame that fails
  /// any check is answered and dropped; the socket survives every case here.
  const read = (
    ws: WebSocket,
    data: RawData,
    isBinary: boolean,
    to: string,
  ): { frame: Frame; text: string } | null => {
    const refuse = (code: string) => {
      send(ws, { v: 1, to, type: "error", body: { code } });
      return null;
    };
    const bytes = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
    if (bytes.length > MAX_FRAME) return refuse("frame-too-large");
    if (isBinary) return refuse("bad-frame");
    const text = bytes.toString("utf8");
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return refuse("bad-frame");
    }
    if (!frame || typeof frame !== "object" || frame.v !== 1) return refuse("bad-frame");
    return { frame, text };
  };

  const attachHost = (hostId: string, ws: WebSocket) => {
    const room = roomFor(hostId);
    // Election lives here because the relay is the only thing every MonoCode
    // window can see (diagram 03, "Multi-Window Leader Election").
    if (room.host) {
      ws.close(4409, "host-already-connected");
      return;
    }
    room.host = ws;
    for (const [id, client] of room.clients) send(client, { v: 1, to: id, type: "host-online" });

    ws.on("message", (data, isBinary) => {
      const envelope = read(ws, data, isBinary, "host");
      if (!envelope) return;
      const target = room.clients.get(String(envelope.frame.to ?? ""));
      if (!target) return; // client already gone — nothing to route to
      // Backpressure is a close, not a queue: a phone in a tunnel must not grow
      // an unbounded buffer on the relay.
      if (target.bufferedAmount > MAX_BUFFER) {
        target.close(1013, "client-too-slow");
        return;
      }
      target.send(envelope.text); // verbatim: the host addressed it already
    });

    ws.on("close", () => {
      if (room.host !== ws) return; // a 4409 loser closing is not a leader change
      room.host = null;
      for (const [id, client] of room.clients) send(client, { v: 1, to: id, type: "host-offline" });
      forget(hostId, room);
    });
  };

  const attachClient = (hostId: string, ws: WebSocket) => {
    const room = roomFor(hostId);
    // ponytail: per-connection id, not a device identity. T6 keys the room by
    // the deviceId the token proves.
    const id = randomUUID();
    room.clients.set(id, ws);
    send(ws, { v: 1, to: id, type: room.host ? "host-online" : "host-offline" });

    ws.on("message", (data, isBinary) => {
      const envelope = read(ws, data, isBinary, id);
      if (!envelope) return;
      if (!room.host) {
        send(ws, { v: 1, to: id, type: "error", body: { id: envelope.frame.id, code: "host-offline" } });
        return;
      }
      // Stamp the sender so the host can address its reply. `from` is set last,
      // so a client cannot claim to be another one. `body` rides through as-is.
      room.host.send(JSON.stringify({ ...envelope.frame, from: id }));
    });

    ws.on("close", () => {
      room.clients.delete(id);
      forget(hostId, room);
    });
  };

  const http = createServer((_req, res) => {
    res.writeHead(404).end(); // HTTP surface (register, pairing, devices) is T6
  });
  // Outer guard only: ws closes anything past this itself. Frames between
  // MAX_FRAME and MAX_BUFFER get the friendly `frame-too-large` above.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const clientPath = CLIENT_PATH.exec(url.pathname);
    const isHost = url.pathname === "/ws/host";
    const hostId = clientPath
      ? decodeURIComponent(clientPath[1])
      : (url.searchParams.get("hostId") ?? "");
    if (!(isHost || clientPath) || !ID.test(hostId)) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); // status only, no detail
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (isHost) attachHost(hostId, ws);
      else attachClient(hostId, ws);
    });
  });

  return http;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  createRelay().listen(port, () => console.log(`relay listening on :${port}`));
}
