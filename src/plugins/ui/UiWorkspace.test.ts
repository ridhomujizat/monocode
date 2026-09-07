import { describe, expect, it } from "vitest";
import { parseBridgeCall, uiUrl } from "./UiWorkspace";

describe("parseBridgeCall", () => {
  it("accepts a well-formed bridge call", () => {
    expect(
      parseBridgeCall({
        monocode: { seq: 3, action: "request", method: "GET", url: "https://x" },
      }),
    ).toEqual({
      seq: 3,
      action: "request",
      fields: { method: "GET", url: "https://x" },
    });
  });

  it("rejects noise, wrong shapes and missing fields", () => {
    expect(parseBridgeCall(null)).toBeNull();
    expect(parseBridgeCall("hello")).toBeNull();
    expect(parseBridgeCall({ other: 1 })).toBeNull();
    expect(parseBridgeCall({ monocode: "x" })).toBeNull();
    expect(parseBridgeCall({ monocode: { action: "request" } })).toBeNull();
    expect(parseBridgeCall({ monocode: { seq: 1, action: 42 } })).toBeNull();
  });
});

describe("uiUrl", () => {
  it("encodes entry segments but keeps the path shape", () => {
    expect(uiUrl("board", "index.html")).toBe("pluginui://localhost/board/index.html");
    expect(uiUrl("board", "pages/my page.html")).toBe(
      "pluginui://localhost/board/pages/my%20page.html",
    );
  });
});
