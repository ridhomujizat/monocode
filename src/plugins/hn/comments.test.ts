import { describe, expect, it } from "vitest";
import { flattenComments, stripHtml } from "./comments";

describe("stripHtml", () => {
  it("keeps text, decodes entities, breaks on block tags", () => {
    expect(
      stripHtml("A &amp; B<p>C &lt;tag&gt; &#x27;quoted&#39;</p><p>D</p>"),
    ).toBe("A & B\nC <tag> 'quoted'\n\nD");
  });

  it("drops inline tags without breaks", () => {
    expect(stripHtml('see <a href="x">this</a> and <i>that</i>')).toBe(
      "see this and that",
    );
  });

  it("decodes numeric entities", () => {
    expect(stripHtml("caf&#xe9;")).toBe("café");
  });
});

describe("flattenComments", () => {
  const tree = {
    author: "a",
    text: "top",
    children: [
      {
        author: "b",
        text: "<p>reply</p>",
        children: [
          {
            author: "c",
            text: "deep",
            children: [{ author: "d", text: "past cap" }],
          },
        ],
      },
      { author: null, text: "deleted", children: [] },
      { text: "no author", children: [] },
    ],
  };

  it("flattens depth-first with depth, skips deleted, caps depth", () => {
    expect(flattenComments(tree, 10)).toEqual([
      { author: "a", text: "top", depth: 0 },
      { author: "b", text: "reply", depth: 1 },
      { author: "c", text: "deep", depth: 2 },
      { author: "d", text: "past cap", depth: 3 },
    ]);
  });

  it("honours the max cap", () => {
    expect(flattenComments(tree, 2)).toHaveLength(2);
  });

  it("tolerates garbage", () => {
    expect(flattenComments(null, 10)).toEqual([]);
    expect(flattenComments("nope", 10)).toEqual([]);
  });
});
