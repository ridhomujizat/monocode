import { describe, expect, it } from "vitest";
import {
  itemBody,
  itemTitle,
  itemsOf,
  missingFields,
  pick,
  render,
  requestHeaders,
  validateManifest,
  type PluginManifest,
} from "./manifest";

const jira: PluginManifest = {
  id: "jira",
  label: "Jira",
  fields: [
    { key: "baseUrl", label: "Base URL" },
    { key: "email" },
    { key: "token", secret: true },
  ],
  auth: { kind: "basic", user: "{{email}}", password: "{{token}}" },
  request: {
    url: "{{baseUrl}}/rest/api/3/search",
    headers: { Accept: "application/json" },
  },
  items: "issues",
  item: {
    title: "{{key}} · {{fields.summary}}",
    subtitle: "{{fields.status.name}}",
  },
};

describe("manifest validation", () => {
  it("accepts a manifest with only the required keys", () => {
    const check = validateManifest({
      id: "ping",
      label: "Ping",
      request: { url: "https://example.dev/ping" },
    });
    expect("manifest" in check).toBe(true);
  });

  it("accepts the jira shape", () => {
    expect(validateManifest(jira)).toEqual({ manifest: jira });
  });

  it("reports what to fix", () => {
    const error = (value: unknown) => {
      const check = validateManifest(value);
      return "error" in check ? check.error : null;
    };
    expect(error("nope")).toMatch(/JSON object/);
    expect(error({ id: "Jira", label: "x", request: { url: "u" } })).toMatch(
      /"id"/,
    );
    expect(error({ id: "jira", request: { url: "u" } })).toMatch(/"label"/);
    expect(error({ id: "jira", label: "Jira" })).toMatch(/"request"/);
    expect(error({ id: "jira", label: "Jira", request: {} })).toMatch(
      /"request.url"/,
    );
    expect(
      error({
        id: "jira",
        label: "Jira",
        request: { url: "u", method: "FETCH" },
      }),
    ).toMatch(/"request.method"/);
    expect(
      error({ id: "jira", label: "Jira", request: { url: "u" }, items: "a" }),
    ).toMatch(/"item.title"/);
    expect(
      error({
        id: "jira",
        label: "Jira",
        request: { url: "u" },
        auth: { kind: "oauth" },
      }),
    ).toMatch(/"auth"/);
  });
});

describe("templates", () => {
  it("fills dotted paths and renders misses as empty", () => {
    const scope = { key: "PROJ-1", fields: { summary: "Fix login" } };
    expect(render("{{key}} · {{fields.summary}}", scope)).toBe(
      "PROJ-1 · Fix login",
    );
    expect(render("[{{fields.missing.deep}}]", scope)).toBe("[]");
    expect(render("{{fields}}", scope)).toBe('{"summary":"Fix login"}');
  });

  it("takes the value itself for a list of strings", () => {
    expect(render("{{.}}", "notes/Idea.md")).toBe("notes/Idea.md");
    expect(
      itemTitle(
        {
          id: "x",
          label: "X",
          request: { url: "u" },
          item: { title: "{{$}}" },
        },
        "notes/Idea.md",
      ),
    ).toBe("notes/Idea.md");
  });

  it("walks arrays and stops at a bad path", () => {
    expect(pick({ a: [{ b: 2 }] }, "a.0.b")).toBe(2);
    expect(pick({ a: 1 }, "a.b")).toBeUndefined();
    expect(pick({ a: 1 }, "")).toEqual({ a: 1 });
  });
});

describe("request building", () => {
  it("turns basic auth into an Authorization header", () => {
    const headers = requestHeaders(jira, {
      baseUrl: "https://acme.atlassian.net",
      email: "me@acme.dev",
      token: "secret",
    });
    expect(headers).toEqual([
      ["Accept", "application/json"],
      ["Authorization", `Basic ${btoa("me@acme.dev:secret")}`],
    ]);
  });

  it("turns bearer auth into an Authorization header", () => {
    expect(
      requestHeaders(
        {
          ...jira,
          auth: { kind: "bearer", token: "{{token}}" },
          request: { url: "u" },
        },
        { token: "abc" },
      ),
    ).toEqual([["Authorization", "Bearer abc"]]);
  });

  it("treats blank config values as unfilled", () => {
    expect(
      missingFields(jira, { baseUrl: "https://x.dev", email: " ", token: "t" }),
    ).toEqual([{ key: "email" }]);
    expect(missingFields(jira, null).length).toBe(3);
  });
});

describe("items", () => {
  const response = { issues: [{ key: "A-1", fields: { summary: "One" } }] };

  it("reads the array at the given path", () => {
    expect(itemsOf(response, "issues")).toHaveLength(1);
    expect(itemsOf([1, 2], "")).toEqual([1, 2]);
    expect(itemsOf(response, "nope")).toEqual([]);
  });

  it("renders a title and falls back to json for the body", () => {
    const item = response.issues[0];
    expect(itemTitle(jira, item)).toBe("A-1 · One");
    expect(itemTitle(jira, {})).toBe("Untitled");
    expect(itemBody(jira, item)).toBe(JSON.stringify(item, null, 2));
    expect(
      itemBody({ ...jira, item: { title: "t", body: "{{key}}!" } }, item),
    ).toBe("A-1!");
  });
});

describe("process plugins", () => {
  const media = {
    id: "media",
    label: "Media",
    card: { title: "MEDIA" },
    startup: [{ command: ["/usr/bin/perl", "media.pl", "start"] }],
    actions: [
      { id: "playpause", title: "Play / pause", command: ["sh", "c.sh", "pp"] },
    ],
  };

  const error = (value: unknown) => {
    const check = validateManifest(value);
    return "error" in check ? check.error : null;
  };

  it("accepts a manifest with commands and no request", () => {
    expect(validateManifest(media)).toEqual({ manifest: media });
  });

  it("needs a request, commands, or a ui", () => {
    expect(error({ id: "x", label: "X" })).toMatch(/"request".*"startup"/);
    expect(error({ id: "x", label: "X", ui: "index.html" })).toBeNull();
  });

  it("validates the ui entry path", () => {
    expect(error({ id: "x", label: "X", ui: "app.js" })).toMatch(/\.html/);
    expect(error({ id: "x", label: "X", ui: "../other/index.html" })).toMatch(
      /inside the plugin folder/,
    );
    expect(error({ id: "x", label: "X", ui: "/etc/index.html" })).toMatch(
      /inside the plugin folder/,
    );
    expect(error({ id: "x", label: "X", ui: true })).toMatch(/relative path/);
  });

  it("needs a startup command to fill a card", () => {
    expect(error({ ...media, startup: undefined })).toMatch(/"card" needs/);
  });

  it("checks argv and action ids", () => {
    expect(error({ ...media, startup: [{ command: [] }] })).toMatch(
      /non-empty "command"/,
    );
    expect(error({ ...media, startup: [{ command: ["sh", 2] }] })).toMatch(
      /non-empty strings/,
    );
    expect(
      error({
        ...media,
        actions: [{ id: "Play", title: "t", command: ["sh"] }],
      }),
    ).toMatch(/"id"/);
    expect(
      error({
        ...media,
        actions: [
          { id: "a", title: "t", command: ["sh"] },
          { id: "a", title: "t", command: ["sh"] },
        ],
      }),
    ).toMatch(/duplicate action/);
  });
});
