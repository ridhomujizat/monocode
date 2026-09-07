import { describe, expect, it } from "vitest";
import { LanguageSupport } from "@codemirror/language";
import { languageForPath } from "./editorLanguage";

describe("languageForPath", () => {
  it("returns Go support for .go files", async () => {
    const extension = await languageForPath("internal/grpc/x.integration.go");
    expect(extension).not.toBeNull();
  });

  it("keeps every language pack behind a LanguageSupport extension", async () => {
    for (const path of ["a.ts", "a.json", "a.rs", "a.py", "a.go"]) {
      expect(await languageForPath(path)).toBeInstanceOf(LanguageSupport);
    }
  });

  it("returns null for unknown types", async () => {
    expect(await languageForPath("a.unknown")).toBeNull();
  });
});
