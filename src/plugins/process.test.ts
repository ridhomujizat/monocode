import { describe, expect, it } from "vitest";
import { decodePush } from "./process";

const ACTIONS = ["playpause", "next"];

describe("plugin stdout lines", () => {
  it("decodes a card push", () => {
    expect(
      decodePush(
        '{"method":"card","params":{"rows":[{"text":"▶ Song","action":"playpause","value":"+10"},{"text":"idle","dot":"idle"}]}}',
        ACTIONS,
      ),
    ).toEqual({
      method: "card",
      rows: [
        { text: "▶ Song", action: "playpause", value: "+10" },
        { text: "idle", dot: "idle" },
      ],
    });
  });

  it("treats plain output as a log line, and blank as nothing", () => {
    expect(decodePush("starting up", ACTIONS)).toEqual({ log: "starting up" });
    expect(decodePush("{not json", ACTIONS)).toEqual({ log: "{not json" });
    expect(decodePush("   ", ACTIONS)).toBeNull();
  });

  it("refuses a row naming an action the manifest never declared", () => {
    const push = decodePush(
      '{"method":"card","params":{"rows":[{"text":"x","action":"seek"}]}}',
      ACTIONS,
    );
    expect(push).toEqual({ error: 'no action "seek" in the manifest' });
  });

  it("reports the other ways a push can be wrong", () => {
    const error = (line: string) => {
      const push = decodePush(line, ACTIONS);
      return push && "error" in push ? push.error : null;
    };
    expect(error('{"method":"toast","params":{}}')).toMatch(/unknown method/);
    expect(error('{"method":"card","params":{}}')).toMatch(/params.rows/);
    expect(error('{"method":"card","params":{"rows":[1]}}')).toMatch(
      /must be an object/,
    );
    expect(error('{"method":"card","params":{"rows":[{}]}}')).toMatch(/"text"/);
    expect(
      error('{"method":"card","params":{"rows":[{"text":"x","dot":"neon"}]}}'),
    ).toMatch(/"dot"/);
  });

  it("keeps media fields on a card row", () => {
    expect(
      decodePush(
        JSON.stringify({
          method: "card",
          params: {
            rows: [
              {
                text: "Song",
                subtext: "Artist · Album",
                image: "/tmp/art.jpg",
                imageKey: "id-1",
                progress: 0.4,
                clock: "1:00/2:30",
                icon: "Play",
                group: "transport",
                action: "playpause",
              },
            ],
          },
        }),
        ACTIONS,
      ),
    ).toEqual({
      method: "card",
      rows: [
        {
          text: "Song",
          subtext: "Artist · Album",
          image: "/tmp/art.jpg",
          imageKey: "id-1",
          progress: 0.4,
          clock: "1:00/2:30",
          icon: "Play",
          group: "transport",
          action: "playpause",
        },
      ],
    });
  });
});
