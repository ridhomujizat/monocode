import { describe, expect, it } from "vitest";
import { iconByName } from "./registry";
import * as icons from "../chrome/icons";

describe("iconByName", () => {
  it("resolves export names, including forwardRef components", () => {
    // Hugeicons components are forwardRef objects; the lookup must accept
    // them, not only plain functions.
    expect(iconByName("Zap")).toBe(icons.Zap);
    expect(iconByName("ListFilter")).toBe(icons.ListFilter);
  });

  it("falls back to Wrench for unknown or missing names", () => {
    expect(iconByName("NotAnIcon")).toBe(icons.Wrench);
    expect(iconByName("wrench")).toBe(icons.Wrench); // wrong case = unknown
    expect(iconByName(undefined)).toBe(icons.Wrench);
  });
});
