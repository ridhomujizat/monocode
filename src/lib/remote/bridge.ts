/**
 * Reads desktop session state and streams it to remote clients.
 *
 * The desktop stays the single writer (ADR 0002): this module answers frames
 * by reading the same in-memory `Session[]` the UI renders. It never parses
 * agent output — `src/lib/harness/*` has already done that for the desktop.
 *
 * Everything below the store at the bottom is a pure function from frames plus
 * state to frames, which is what makes it testable without a socket.
 */
import { pendingApprovalForSession } from "../approvalToast";
import type { Block, Session } from "../session";
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  frameBytes,
  type DeltaOp,
  type Frame,
  type FrameType,
  type RemoteSessionState,
  type RemoteSessionSummary,
  type SessionsListBody,
} from "./frames";
import { openConnection, type Connection } from "./connection";

/** Tail sent on a cold attach. Older history stays on the desktop. */
const SNAPSHOT_BLOCKS = 200;
/** Deltas kept per session for resume. Older than this forces a snapshot. */
const RING_ENTRIES = 64;
/**
 * The desktop coalesces PTY output at 8 ms because it is local. Over the WAN
 * leg that would be thousands of tiny frames for no perceptible gain
 * (diagram 03, "Attach and Stream").
 */
const COALESCE_MS = 100;

type Tracked = {
  /** Identity of the last `Session` object seen, so an unchanged one is free. */
  source: Session;
  seq: number;
  blocks: Block[];
  state: RemoteSessionState;
  updatedAt: number;
  ring: Array<{ seq: number; ops: DeltaOp[] }>;
};

export type BridgeOptions = {
  send: (frame: Frame) => void;
  now?: () => number;
  coalesceMs?: number;
};

export type Bridge = {
  /** Called from `App.tsx` whenever `sessions` changes. */
  feed: (sessions: Session[]) => void;
  handle: (frame: Frame) => void;
  /** Runs the coalesced diff now instead of on the timer. */
  flush: () => void;
  dispose: () => void;
};

export function sessionState(session: Session): RemoteSessionState {
  if (pendingApprovalForSession(session)) return "blocked";
  return session.busy ? "running" : "idle";
}

function summarize(session: Session, updatedAt: number): RemoteSessionSummary {
  const pending = pendingApprovalForSession(session);
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    harness: session.harness,
    model: session.model,
    state: sessionState(session),
    updatedAt,
    ...(pending
      ? {
          pendingApproval: {
            requestId: pending.requestId,
            kind: pending.kind,
            label: pending.label,
          },
        }
      : {}),
  };
}

/**
 * `null` when the change cannot be expressed as append-or-replace — a block
 * was removed or reordered (checkpoint restore, compact). The caller sends a
 * fresh snapshot instead, which is correct and only costs bytes.
 */
function diffBlocks(prev: Block[], next: Block[]): DeltaOp[] | null {
  if (next.length < prev.length) return null;
  const ops: DeltaOp[] = [];
  for (let i = 0; i < next.length; i++) {
    const before = prev[i];
    const block = next[i];
    if (before === block) continue;
    if (before && before.id !== block.id) return null;
    ops.push({ id: block.id, block });
  }
  return ops;
}

export function createBridge(options: BridgeOptions): Bridge {
  const now = options.now ?? Date.now;
  const coalesceMs = options.coalesceMs ?? COALESCE_MS;
  const tracked = new Map<string, Tracked>();
  /** sessionId -> client ids streaming it. */
  const attached = new Map<string, Set<string>>();
  /**
   * Every client heard from, so `session.state` reaches a phone that is not
   * attached to anything (that is what drives its list and notifications).
   *
   * ponytail: never pruned — the relay does not tell the host when a client
   * leaves. Bounded in practice from T6, where the client id becomes the
   * paired deviceId and a reconnect reuses it instead of minting a new one.
   */
  const clients = new Set<string>();
  let sessions: Session[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (to: string, type: FrameType, body: unknown) =>
    options.send({ v: PROTOCOL_VERSION, to, type, body });

  const ack = (to: string, id?: string) => emit(to, "ack", { id });
  const fail = (to: string, id: string | undefined, code: string) =>
    emit(to, "error", { id, code });

  const snapshotFrame = (to: string, sessionId: string, entry: Tracked): Frame => {
    let count = Math.min(SNAPSHOT_BLOCKS, entry.blocks.length);
    for (;;) {
      const blocks = entry.blocks.slice(entry.blocks.length - count);
      const frame: Frame = {
        v: PROTOCOL_VERSION,
        to,
        type: "session.snapshot",
        body: {
          sessionId,
          blocks,
          seq: entry.seq,
          truncated: count < entry.blocks.length,
        },
      };
      if (count === 0 || frameBytes(frame) <= MAX_FRAME_BYTES) return frame;
      // ponytail: halve until it fits. A single block over 1 MB ends up as an
      // empty truncated snapshot — the phone says "more on the desktop"
      // instead of asking the relay for a frame it will refuse.
      count = count > 1 ? Math.floor(count / 2) : 0;
    }
  };

  /**
   * Reconcile tracked state with the latest `sessions`, emitting deltas and
   * state changes. Runs on the coalescing timer and before answering any frame
   * that reports state, so a remote client never reads a stale transcript.
   */
  const sync = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const live = new Set<string>();
    for (const session of sessions) {
      // Inbox Ask conversations are temporary and never listed (approvalToast
      // skips them for the same reason).
      if (session.inboxAsk) continue;
      live.add(session.id);
      const entry = tracked.get(session.id);
      if (entry?.source === session) continue;
      const state = sessionState(session);
      if (!entry) {
        tracked.set(session.id, {
          source: session,
          seq: 0,
          blocks: session.blocks,
          state,
          updatedAt: now(),
          ring: [],
        });
        for (const client of clients) {
          emit(client, "session.state", { sessionId: session.id, state });
        }
        continue;
      }
      const ops = diffBlocks(entry.blocks, session.blocks);
      const streaming = attached.get(session.id);
      if (ops === null || ops.length > 0) {
        entry.seq += 1;
        entry.blocks = session.blocks;
        entry.updatedAt = now();
        if (ops === null) {
          entry.ring.length = 0;
        } else {
          entry.ring.push({ seq: entry.seq, ops });
          if (entry.ring.length > RING_ENTRIES) entry.ring.shift();
        }
        for (const client of streaming ?? []) {
          if (ops === null) {
            options.send(snapshotFrame(client, session.id, entry));
            continue;
          }
          const frame: Frame = {
            v: PROTOCOL_VERSION,
            to: client,
            type: "session.delta",
            body: { sessionId: session.id, ops, seq: entry.seq },
          };
          // An op can carry a huge tool output. Silently dropping it would
          // leave that client diverged forever, so resnapshot instead.
          if (frameBytes(frame) > MAX_FRAME_BYTES) {
            entry.ring.length = 0;
            options.send(snapshotFrame(client, session.id, entry));
          } else {
            options.send(frame);
          }
        }
      }
      if (state !== entry.state) {
        entry.state = state;
        for (const client of clients) {
          emit(client, "session.state", { sessionId: session.id, state });
        }
      }
      entry.source = session;
    }
    for (const id of tracked.keys()) {
      if (!live.has(id)) {
        tracked.delete(id);
        attached.delete(id);
      }
    }
  };

  /** Ring ops after `sinceSeq`, or `null` when only a snapshot can be correct. */
  const replay = (entry: Tracked, sinceSeq: number): DeltaOp[] | null => {
    if (sinceSeq === entry.seq) return [];
    if (sinceSeq > entry.seq || sinceSeq < 0) return null;
    const oldest = entry.ring[0];
    if (!oldest || oldest.seq > sinceSeq + 1) return null;
    return entry.ring
      .filter((item) => item.seq > sinceSeq)
      .flatMap((item) => item.ops);
  };

  const handle = (frame: Frame) => {
    // The relay stamps `from`; a frame without it is not addressable.
    const client = typeof frame.from === "string" ? frame.from : null;
    if (!client) return;
    clients.add(client);
    const id = typeof frame.id === "string" ? frame.id : undefined;
    const body = (frame.body ?? {}) as Record<string, unknown>;
    sync();

    switch (frame.type) {
      case "sessions.list": {
        const filter = body as SessionsListBody;
        const page: RemoteSessionSummary[] = [];
        for (const session of sessions) {
          const entry = tracked.get(session.id);
          if (!entry) continue;
          if (filter.projectCwd && session.cwd !== filter.projectCwd) continue;
          page.push(summarize(session, entry.updatedAt));
        }
        emit(client, "sessions.page", { sessions: page });
        ack(client, id);
        return;
      }
      case "session.attach": {
        const sessionId = body.sessionId;
        if (typeof sessionId !== "string") return fail(client, id, "bad-frame");
        const entry = tracked.get(sessionId);
        if (!entry) return fail(client, id, "not-found");
        let set = attached.get(sessionId);
        if (!set) attached.set(sessionId, (set = new Set()));
        set.add(client);
        const sinceSeq = typeof body.sinceSeq === "number" ? body.sinceSeq : 0;
        const ops = sinceSeq > 0 ? replay(entry, sinceSeq) : null;
        if (ops === null) {
          options.send(snapshotFrame(client, sessionId, entry));
        } else if (ops.length > 0) {
          emit(client, "session.delta", { sessionId, ops, seq: entry.seq });
        }
        ack(client, id);
        return;
      }
      case "session.detach": {
        const sessionId = body.sessionId;
        if (typeof sessionId !== "string") return fail(client, id, "bad-frame");
        attached.get(sessionId)?.delete(client);
        ack(client, id);
        return;
      }
      default:
        // The four steer intents land in T4.
        return fail(client, id, "unsupported");
    }
  };

  return {
    feed: (next) => {
      sessions = next;
      if (timer == null) timer = setTimeout(sync, coalesceMs);
    },
    handle,
    flush: sync,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      tracked.clear();
      attached.clear();
      clients.clear();
      sessions = [];
    },
  };
}

// ---------------------------------------------------------------------------
// One bridge per window, off until something starts it. Nothing in the app
// calls `startRemoteBridge` yet: the settings toggle is T6, so with remote
// disabled this store holds `null`, opens no socket and costs one branch.
// ---------------------------------------------------------------------------

let live: { bridge: Bridge; connection: Connection } | null = null;

export function feedRemoteBridge(sessions: Session[]) {
  live?.bridge.feed(sessions);
}

export function startRemoteBridge(url: string) {
  stopRemoteBridge();
  let connection: Connection | null = null;
  const bridge = createBridge({ send: (frame) => connection?.send(frame) });
  connection = openConnection({ url, onFrame: bridge.handle });
  live = { bridge, connection };
}

export function stopRemoteBridge() {
  live?.connection.close();
  live?.bridge.dispose();
  live = null;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev seam for the T3 gate: drive the bridge from the devtools console until
  // T6 gives it a settings toggle.
  (window as unknown as Record<string, unknown>).__monocodeRemote = {
    start: startRemoteBridge,
    stop: stopRemoteBridge,
  };
}
