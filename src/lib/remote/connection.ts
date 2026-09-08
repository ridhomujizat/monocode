/**
 * Outbound socket to the relay: dial, read frames, redial.
 *
 * The socket is injectable so the lifecycle can be tested without a network
 * (ADR 0002 — the bridge is a pure function from frames and state to frames).
 */
import { decodeFrame, encodeFrame, type Frame } from "./frames";

const BASE_MS = 1000;
const CAP_MS = 30_000;
/** Another window holds the room. Not an error, so no backoff ramp. */
const LEADER_RETRY_MS = 15_000;
const HOST_ALREADY_CONNECTED = 4409;

/**
 * Full jitter: uniform in `[0, cap]`, cap doubling 1 s -> 30 s. Uniform from
 * zero is the point — every device redialling after a relay restart must land
 * on a different millisecond, so a fixed floor would defeat it.
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(CAP_MS, BASE_MS * 2 ** attempt);
  return Math.round(random() * cap);
}

type SocketLike = Pick<
  WebSocket,
  "readyState" | "send" | "close" | "onopen" | "onclose" | "onmessage" | "onerror"
>;

export type ConnectionOptions = {
  url: string;
  onFrame: (frame: Frame) => void;
  onStatus?: (status: "open" | "closed") => void;
  /** Test seam. Defaults to the platform `WebSocket`. */
  socketFactory?: (url: string) => SocketLike;
  random?: () => number;
};

export type Connection = {
  send: (frame: Frame) => void;
  close: () => void;
};

export function openConnection(options: ConnectionOptions): Connection {
  const factory =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as SocketLike);
  let socket: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const dial = () => {
    timer = null;
    const ws = factory(options.url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      options.onStatus?.("open");
    };
    ws.onmessage = (event: MessageEvent) => {
      const frame = decodeFrame(String(event.data));
      if (frame) options.onFrame(frame);
    };
    ws.onclose = (event: CloseEvent) => {
      socket = null;
      options.onStatus?.("closed");
      if (stopped) return;
      const delay =
        event.code === HOST_ALREADY_CONNECTED
          ? LEADER_RETRY_MS
          : backoffDelay(attempt++, options.random);
      timer = setTimeout(dial, delay);
    };
  };

  dial();

  return {
    send: (frame) => {
      if (socket?.readyState === 1 /* OPEN */) socket.send(encodeFrame(frame));
    },
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      socket?.close();
    },
  };
}
