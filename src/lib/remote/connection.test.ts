import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, openConnection } from "./connection";
import type { Frame } from "./frames";

type Handlers = {
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: string }) => void;
};

function fakeSocket() {
  const socket = {
    readyState: 1,
    sent: [] as string[],
    send(text: string) {
      socket.sent.push(text);
    },
    close() {},
  } as Handlers & { readyState: number; sent: string[]; send: (t: string) => void; close: () => void };
  return socket;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay", () => {
  it("is full jitter under a cap that doubles from 1s to 30s", () => {
    expect(backoffDelay(0, () => 0)).toBe(0);
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(5, () => 1)).toBe(30_000);
    expect(backoffDelay(40, () => 1)).toBe(30_000);
  });

  it("draws a different delay each time, so devices do not redial in lockstep", () => {
    const draws = new Set(
      Array.from({ length: 32 }, () => backoffDelay(4)),
    );
    expect(draws.size).toBeGreaterThan(1);
  });
});

describe("openConnection", () => {
  it("retries a lost leader election on a flat 15s, not the backoff ramp", () => {
    vi.useFakeTimers();
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    openConnection({
      url: "wss://relay.example/ws/host",
      onFrame: () => {},
      socketFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket as never;
      },
      // Any backoff draw would be under 1s at attempt 0, so a wrong branch
      // shows up as an early redial.
      random: () => 0.5,
    });
    expect(sockets).toHaveLength(1);

    sockets[0].onclose?.({ code: 4409 });
    vi.advanceTimersByTime(14_999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  it("drops frames that are not this protocol", () => {
    const seen: Frame[] = [];
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    openConnection({
      url: "wss://relay.example/ws/host",
      onFrame: (frame) => seen.push(frame),
      socketFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket as never;
      },
    });
    const socket = sockets[0];
    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({ data: JSON.stringify({ v: 2, to: "host", type: "ack" }) });
    socket.onmessage?.({ data: JSON.stringify({ v: 1, to: "d_1", type: "ack" }) });
    expect(seen.map((frame) => frame.type)).toEqual(["ack"]);
  });
});
