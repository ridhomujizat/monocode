import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { KerjanTicket } from "../model/kerjan";
import { kerjanStoryChatBody } from "./KerjanTicketActions";

function ticket(overrides: Partial<KerjanTicket> = {}): KerjanTicket {
  return {
    id: 1,
    key: "PRD-1",
    workspace_id: 1,
    kind: "task",
    title: "Task",
    status: "todo",
    assignee_id: null,
    created_at: "2026-09-25T03:58:57Z",
    ...overrides,
  };
}

describe("kerjanStoryChatBody", () => {
  it("lists the open Tasks, marks the current one and drops canceled ones", () => {
    const story = ticket({
      key: "PRD-10",
      kind: "story",
      title: "Dashboard",
      status: "in_progress",
      description: "Build the dashboard.",
      tasks: [
        ticket({
          key: "PRD-11",
          title: "Build API",
          task_type: "dev",
          status: "done",
          assignee_id: 7,
          description: "REST endpoints\nwith auth",
        }),
        ticket({ key: "PRD-12", title: "Fix bug", task_type: "bug" }),
        ticket({
          key: "PRD-13",
          title: "Old task",
          canceled_at: "2026-09-25T06:40:15Z",
        }),
      ],
    });
    const members = [{ id: 7, name: "Ridho", kind: "dev", active: true }];
    expect(kerjanStoryChatBody(story, members, "PRD-12")).toBe(
      [
        "Parent story: PRD-10 Dashboard (In Progress)",
        "",
        "Build the dashboard.",
        "",
        "Tasks (1/2 done):",
        "- [x] PRD-11 Build API (dev · Done · Ridho)",
        "  REST endpoints",
        "  with auth",
        "- [ ] PRD-12 Fix bug (bug · To Do) ← this ticket",
      ].join("\n"),
    );
  });

  it("stays a bare Story when it has no Tasks", () => {
    expect(
      kerjanStoryChatBody(ticket({ key: "PRD-10", title: "Dashboard" })),
    ).toBe("Parent story: PRD-10 Dashboard (To Do)");
  });
});
