import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import { createRelay } from "./server.ts";

type Frame = Record<string, any>;

/// A peer whose message listener is attached before the socket opens: the relay
/// greets a client the moment it upgrades, and `ws` can emit `open` and that
/// first `message` in one synchronous batch.
function peer(ws: WebSocket) {
  const queue: Frame[] = [];
  let waiting: ((frame: Frame) => void) | null = null;
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    const resolve = waiting;
    waiting = null;
    if (resolve) resolve(frame);
    else queue.push(frame);
  });
  return {
    ws,
    send: (fields: Frame) => ws.send(JSON.stringify({ v: 1, ...fields })),
    next: async (): Promise<Frame> =>
      queue.shift() ?? new Promise<Frame>((resolve) => (waiting = resolve)),
    queued: () => queue.length,
  };
}

async function relay(t: TestContext) {
  const server = createRelay();
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const sockets: WebSocket[] = [];
  t.after(() => {
    for (const socket of sockets) socket.terminate();
    server.close();
  });
  const connect = (path: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(ws);
    return ws;
  };
  return {
    connect,
    open: async (path: string) => {
      const it = peer(connect(path));
      await once(it.ws, "open");
      return it;
    },
  };
}

test("splices host frames to the addressed client and client frames to the host", async (t) => {
  const { open } = await relay(t);
  const host = await open("/ws/host?hostId=h1");
  const c1 = await open("/ws/c/h1");
  assert.equal((await c1.next()).type, "host-online");
  const c2 = await open("/ws/c/h1");
  assert.equal((await c2.next()).type, "host-online");

  c1.send({ to: "host", id: "c7", type: "session.attach", body: { sessionId: "s1", sinceSeq: 0 } });
  const attach = await host.next();
  assert.equal(attach.type, "session.attach");
  assert.deepEqual(attach.body, { sessionId: "s1", sinceSeq: 0 });
  assert.equal(typeof attach.from, "string");

  host.send({ to: attach.from, id: "h9", type: "session.snapshot", body: { seq: 412 } });
  const snapshot = await c1.next();
  assert.equal(snapshot.type, "session.snapshot");
  assert.deepEqual(snapshot.body, { seq: 412 });
  assert.equal(c2.queued(), 0); // addressed to c1, so c2 hears nothing
});

test("a second host loses the room with 4409", async (t) => {
  const { open, connect } = await relay(t);
  const first = await open("/ws/host?hostId=h1");
  const second = connect("/ws/host?hostId=h1");
  const [code, reason] = await once(second, "close");
  assert.equal(code, 4409);
  assert.equal(String(reason), "host-already-connected");
  assert.equal(first.ws.readyState, WebSocket.OPEN);
});

test("an oversized frame is refused without killing the socket", async (t) => {
  const { open } = await relay(t);
  const host = await open("/ws/host?hostId=h1");
  const c1 = await open("/ws/c/h1");
  assert.equal((await c1.next()).type, "host-online");

  c1.send({ to: "host", id: "big", type: "prompt.send", body: { text: "x".repeat(1024 * 1024) } });
  const error = await c1.next();
  assert.equal(error.type, "error");
  assert.equal(error.body.code, "frame-too-large");
  assert.equal(c1.ws.readyState, WebSocket.OPEN);
  assert.equal(host.queued(), 0); // and nothing was forwarded

  c1.send({ to: "host", id: "c8", type: "sessions.list", body: {} });
  assert.equal((await host.next()).type, "sessions.list"); // still routing
});

test("a client may connect before the host and is told so", async (t) => {
  const { open } = await relay(t);
  const c1 = await open("/ws/c/h1");
  assert.equal((await c1.next()).type, "host-offline");

  c1.send({ to: "host", id: "c1", type: "sessions.list", body: {} });
  const error = await c1.next();
  assert.equal(error.type, "error");
  assert.deepEqual(error.body, { id: "c1", code: "host-offline" });

  await open("/ws/host?hostId=h1");
  assert.equal((await c1.next()).type, "host-online");
});
