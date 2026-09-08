import { describe, expect, it } from "vitest";
import { createBridge } from "./bridge";
import type {
  Frame,
  FrameType,
  SessionDeltaBody,
  SessionSnapshotBody,
  SessionsPageBody,
} from "./frames";
import { newSession, type Block, type Session } from "../session";

const CLIENT = "d_1";

function collect() {
  const sent: Frame[] = [];
  return { sent, send: (frame: Frame) => sent.push(frame) };
}

function block(id: string, text = `line ${id}`): Block {
  return { id, role: "assistant", text };
}

function blocks(count: number): Block[] {
  return Array.from({ length: count }, (_, i) => block(`b${i}`));
}

function bodyOf<T>(sent: Frame[], type: FrameType): T {
  const frame = sent.find((item) => item.type === type);
  if (!frame) throw new Error(`no ${type} frame in [${sent.map((f) => f.type)}]`);
  return frame.body as T;
}

function send(
  bridge: ReturnType<typeof createBridge>,
  type: FrameType,
  body: unknown,
  id = "q1",
) {
  bridge.handle({ v: 1, to: "host", from: CLIENT, id, type, body });
}

/** One immutable append, the way `App.tsx` updates a session. */
function append(session: Session, id: string): Session {
  return { ...session, blocks: [...session.blocks, block(id)] };
}

function feed(bridge: ReturnType<typeof createBridge>, session: Session) {
  bridge.feed([session]);
  bridge.flush();
}

describe("createBridge", () => {
  it("answers a cold attach with the last 200 blocks and truncated set", () => {
    const { sent, send: sink } = collect();
    const bridge = createBridge({ send: sink });
    const session = { ...newSession(), blocks: blocks(250) };
    feed(bridge, session);

    send(bridge, "session.attach", { sessionId: session.id, sinceSeq: 0 });

    const snapshot = bodyOf<SessionSnapshotBody>(sent, "session.snapshot");
    expect(snapshot.blocks).toHaveLength(200);
    expect(snapshot.blocks[0].id).toBe("b50");
    expect(snapshot.seq).toBe(0);
    expect(snapshot.truncated).toBe(true);
    expect(sent.at(-1)?.type).toBe("ack");
  });

  it("does not claim truncation when the whole transcript fits", () => {
    const { sent, send: sink } = collect();
    const bridge = createBridge({ send: sink });
    const session = { ...newSession(), blocks: blocks(3) };
    feed(bridge, session);

    send(bridge, "session.attach", { sessionId: session.id, sinceSeq: 0 });

    const snapshot = bodyOf<SessionSnapshotBody>(sent, "session.snapshot");
    expect(snapshot.blocks).toHaveLength(3);
    expect(snapshot.truncated).toBe(false);
  });

  it("turns state changes into deltas with a monotonic seq", () => {
    const { sent, send: sink } = collect();
    const bridge = createBridge({ send: sink });
    let session = { ...newSession(), blocks: blocks(2) };
    feed(bridge, session);
    send(bridge, "session.attach", { sessionId: session.id, sinceSeq: 0 });

    session = append(session, "b2");
    feed(bridge, session);
    session = append(session, "b3");
    feed(bridge, session);
    // A streaming block is replaced by id, not appended.
    session = {
      ...session,
      blocks: [...session.blocks.slice(0, -1), block("b3", "line b3 more")],
    };
    feed(bridge, session);

    const deltas = sent
      .filter((frame) => frame.type === "session.delta")
      .map((frame) => frame.body as SessionDeltaBody);
    expect(deltas.map((delta) => delta.seq)).toEqual([1, 2, 3]);
    expect(deltas.map((delta) => delta.ops.map((op) => op.id))).toEqual([
      ["b2"],
      ["b3"],
      ["b3"],
    ]);
    expect(deltas[2].ops[0].block.text).toBe("line b3 more");
  });

  it("replays from the ring when attach carries a sinceSeq", () => {
    const { sent, send: sink } = collect();
    const bridge = createBridge({ send: sink });
    let session = { ...newSession(), blocks: blocks(2) };
    feed(bridge, session);
    for (const id of ["b2", "b3", "b4"]) {
      session = append(session, id);
      feed(bridge, session);
    }

    send(bridge, "session.attach", { sessionId: session.id, sinceSeq: 1 });

    expect(sent.some((frame) => frame.type === "session.snapshot")).toBe(false);
    const delta = bodyOf<SessionDeltaBody>(sent, "session.delta");
    expect(delta.seq).toBe(3);
    expect(delta.ops.map((op) => op.id)).toEqual(["b3", "b4"]);
  });

  it("sends a fresh snapshot when sinceSeq is older than the ring", () => {
    const { sent, send: sink } = collect();
    const bridge = createBridge({ send: sink });
    let session = { ...newSession(), blocks: blocks(1) };
    feed(bridge, session);
    for (let i = 0; i < 70; i++) {
      session = append(session, `x${i}`);
      feed(bridge, session);
    }

    send(bridge, "session.attach", { sessionId: session.id, sinceSeq: 1 });

    const snapshot = bodyOf<SessionSnapshotBody>(sent, "session.snapshot");
    expect(snapshot.seq).toBe(70);
    expect(sent.some((frame) => frame.type === "session.delta")).toBe(false);
  });

  it("reports blocked, running and idle in the session page", () => {
    const { sent, send: sink } = collect();
    const bridge = createBridge({ send: sink, now: () => 1_700_000 });
    const idle = { ...newSession(), title: "Idle", blocks: blocks(1) };
    const running = { ...newSession(), title: "Running", busy: true };
    const blocked = {
      ...newSession(),
      title: "Blocked",
      busy: true,
      blocks: [
        { ...block("a0"), role: "tool" as const, approval: { requestId: 7 } },
      ],
    };
    bridge.feed([idle, running, blocked]);
    bridge.flush();

    send(bridge, "sessions.list", {});

    const page = bodyOf<SessionsPageBody>(sent, "sessions.page");
    expect(page.sessions.map((entry) => entry.state)).toEqual([
      "idle",
      "running",
      "blocked",
    ]);
    expect(page.sessions[2].pendingApproval?.requestId).toBe(7);
    expect(page.sessions[0].updatedAt).toBe(1_700_000);
  });

  it("refuses an unknown session without touching the socket state", () => {
    const { sent, send: sink } = collect();
    const bridge = createBridge({ send: sink });
    feed(bridge, newSession());

    send(bridge, "session.attach", { sessionId: "nope", sinceSeq: 0 }, "q9");

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].body).toEqual({ id: "q9", code: "not-found" });
  });
});
