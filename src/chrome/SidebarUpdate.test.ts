import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarUpdateFooter } from "./SidebarUpdate";

describe("SidebarUpdateFooter", () => {
  it("stays silent when there is no post-install notice", () => {
    expect(renderToStaticMarkup(createElement(SidebarUpdateFooter, {}))).toBe(
      "",
    );
  });

  it("shows the post-install card without an update row", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarUpdateFooter, {
        update: { version: "0.1.37" },
        onOpenWhatsNew: vi.fn(),
        onDismissUpdate: vi.fn(),
      }),
    );

    expect(markup).toContain("Updated to 0.1.37");
    expect(markup).toContain("What&#x27;s new");
    expect(markup).not.toContain("Check for updates");
    expect(markup).not.toContain("Update to");
  });
});
