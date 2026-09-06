import { describe, expect, it } from "vitest";
import { parseHeaders, prettyBody } from "./index";

describe("http plugin", () => {
  it("parses one header per line and keeps values with colons intact", () => {
    expect(
      parseHeaders(
        "Authorization: Bearer abc\n# comment\n\nX-Url: https://a.dev/x\nbroken\n: nope\n",
      ),
    ).toEqual([
      ["Authorization", "Bearer abc"],
      ["X-Url", "https://a.dev/x"],
    ]);
  });

  it("pretty-prints json bodies and leaves anything else alone", () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody("<html>")).toBe("<html>");
  });
});
