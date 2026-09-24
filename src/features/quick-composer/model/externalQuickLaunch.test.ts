import { describe, expect, it } from "vitest";
import type { AgentModel } from "../../sessions/model/models";
import {
  externalQuickCatalog,
  externalQuickLaunch,
} from "./externalQuickLaunch";

const choice = { harness: "claude", model: "claude-opus" } as const;

describe("externalQuickLaunch", () => {
  it("fills project and model defaults around the prompt", () => {
    expect(externalQuickLaunch({ prompt: "fix it" }, "/repo", choice)).toEqual(
      {
        prompt: "fix it",
        cwd: "/repo",
        harness: "claude",
        model: "claude-opus",
        reveal: false,
      },
    );
  });

  it("uses the project, harness, model and reveal the panel picked", () => {
    expect(
      externalQuickLaunch(
        {
          prompt: "fix it",
          cwd: "/other",
          harness: "codex",
          model: "gpt-5",
          reveal: true,
        },
        "/repo",
        choice,
      ),
    ).toMatchObject({
      cwd: "/other",
      harness: "codex",
      model: "gpt-5",
      reveal: true,
    });
  });

  it("falls back to the default choice for an unknown harness", () => {
    expect(
      externalQuickLaunch(
        { prompt: "fix it", harness: "nope", model: "x" },
        "/repo",
        choice,
      ),
    ).toMatchObject({ harness: "claude", model: "claude-opus" });
  });

  it("drops a launch with no prompt or no project to run in", () => {
    expect(externalQuickLaunch({ prompt: "  " }, "/repo", choice)).toBeNull();
    expect(externalQuickLaunch({ prompt: "fix it" }, null, choice)).toBeNull();
    expect(externalQuickLaunch("fix it", "/repo", choice)).toBeNull();
  });
});

describe("externalQuickCatalog", () => {
  it("names projects and labels models with their upstream provider", () => {
    const models: AgentModel[] = [
      { id: "a", harness: "opencode", name: "Sonnet" },
      {
        id: "b",
        harness: "opencode",
        name: "Kimi",
        provider: { id: "moonshot", name: "Moonshot" },
      },
    ];
    const catalog = externalQuickCatalog(
      ["/home/me/app"],
      "/home/me/app",
      ["opencode"],
      () => models,
      choice,
    );
    expect(catalog.projects).toEqual([{ path: "/home/me/app", name: "app" }]);
    expect(catalog.harnesses[0].models).toEqual([
      { id: "a", name: "Sonnet" },
      { id: "b", name: "Kimi · Moonshot" },
    ]);
    expect(catalog.choice).toBe(choice);
  });
});
