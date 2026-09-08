/**
 * Frame envelope and body shapes for MonoCode Remote (diagram 03,
 * "Frame Envelope").
 *
 * Pure module: no React, no Tauri, no DOM. The mobile bundle imports this file
 * as-is, so nothing here may reach for anything the desktop happens to have.
 */
import type { Block, HarnessId } from "../session";

export const PROTOCOL_VERSION = 1;

/** Relay hard limit. Anything larger is a snapshot that should have truncated. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export type FrameType =
  | "hello"
  | "sessions.list"
  | "sessions.page"
  | "session.attach"
  | "session.snapshot"
  | "session.delta"
  | "session.detach"
  | "prompt.send"
  | "approval.decide"
  | "question.answer"
  | "session.interrupt"
  | "session.state"
  | "ack"
  | "error"
  | "host-online"
  | "host-offline";

export type Frame = {
  v: typeof PROTOCOL_VERSION;
  /** `"host"`, or the client id the relay assigned. */
  to: string;
  /** Correlation id. Required on client -> host frames, echoed in `ack`. */
  id?: string;
  /** Stamped by the relay on client -> host frames. Clients never write it. */
  from?: string;
  type: FrameType;
  body?: unknown;
};

export type RemoteSessionState = "running" | "blocked" | "idle";

export type RemotePendingApproval = {
  requestId: number;
  kind: "approval" | "question";
  label: string;
};

export type RemoteSessionSummary = {
  id: string;
  title: string;
  cwd: string;
  harness: HarnessId;
  model: string;
  state: RemoteSessionState;
  /** Epoch ms of the last change the bridge saw, not a stored column. */
  updatedAt: number;
  pendingApproval?: RemotePendingApproval;
};

/** Append-or-replace by block id. Blocks are replaced, never mutated. */
export type DeltaOp = { id: string; block: Block };

export type SessionsListBody = { projectCwd?: string; includeArchived?: boolean };
export type SessionsPageBody = { sessions: RemoteSessionSummary[] };
export type SessionAttachBody = { sessionId: string; sinceSeq: number };
export type SessionDetachBody = { sessionId: string };
export type SessionSnapshotBody = {
  sessionId: string;
  blocks: Block[];
  seq: number;
  truncated: boolean;
};
export type SessionDeltaBody = { sessionId: string; ops: DeltaOp[]; seq: number };
export type SessionStateBody = {
  sessionId: string;
  state: RemoteSessionState;
  exitCode?: number;
};
export type AckBody = { id?: string };
export type ErrorBody = { id?: string; code: string; message?: string };

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Envelope-level validation only. An unknown `type` decodes fine and is the
 * handler's problem — that is what lets one side add a frame type before the
 * other learns it.
 */
export function decodeFrame(text: string): Frame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const frame = value as Frame;
  if (frame.v !== PROTOCOL_VERSION) return null;
  if (typeof frame.type !== "string" || typeof frame.to !== "string") return null;
  return frame;
}

const encoder = new TextEncoder();

export function frameBytes(frame: Frame): number {
  return encoder.encode(encodeFrame(frame)).length;
}
