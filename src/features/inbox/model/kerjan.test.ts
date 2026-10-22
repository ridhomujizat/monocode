import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  clearKerjanCache,
  kerjanKeyNumber,
  kerjanNextStatuses,
  kerjanThread,
  kerjanTicketDetails,
  kerjanTicketThread,
  kerjanTicketToIssue,
  listKerjanIssues,
  type KerjanTicket,
} from "./kerjan";

function ticket(overrides: Partial<KerjanTicket> = {}): KerjanTicket {
  return {
    id: 4661,
    key: "PRD-575",
    workspace_id: 1,
    kind: "task",
    title: "Run final verification",
    status: "todo",
    task_type: "dev",
    story_key: "PRD-124",
    story_title: "Dashboard",
    sprint_id: 91,
    assignee_id: 27,
    created_at: "2026-09-25T03:58:57Z",
    ...overrides,
  };
}

describe("kerjanTicketToIssue", () => {
  it("maps a task to an inbox issue under its story", () => {
    const issue = kerjanTicketToIssue(
      ticket(),
      new Map([[27, "Ridho"]]),
      new Map([[91, "Sprint 1"]]),
    );
    expect(issue).toMatchObject({
      provider: "kerjan",
      kind: "kerjan",
      id: "4661",
      identifier: "PRD-575",
      number: 575,
      state: "To Do",
      stateType: "todo",
      repo: "PRD",
      teamName: "PRD-124 Dashboard",
      assignees: [{ login: "Ridho" }],
      url: "",
    });
    expect(issue.labels[0]?.name).toBe("dev");
  });

  it("falls back to the sprint name for stories", () => {
    const issue = kerjanTicketToIssue(
      ticket({ kind: "story", story_key: undefined, assignee_id: null }),
      new Map(),
      new Map([[91, "Sprint 1"]]),
    );
    expect(issue.teamName).toBe("Sprint 1");
    expect(issue.assignees).toEqual([]);
    expect(issue.labels[0]?.name).toBe("story");
  });

  it("uses the completion time once a ticket is done", () => {
    const issue = kerjanTicketToIssue(
      ticket({ status: "done", done_at: "2026-10-01T00:00:00Z" }),
      new Map(),
      new Map(),
    );
    expect(issue.updatedAt).toBe("2026-10-01T00:00:00Z");
  });
});

describe("kerjan helpers", () => {
  it("reads the number from a ticket key", () => {
    expect(kerjanKeyNumber("PRD-40")).toBe(40);
    expect(kerjanKeyNumber("bad")).toBe(0);
  });

  it("only offers transitions Kerjan accepts", () => {
    expect(kerjanNextStatuses("todo")).toEqual(["in_progress"]);
    expect(kerjanNextStatuses("in_progress")).toEqual(["todo", "done"]);
    expect(kerjanNextStatuses("done")).toEqual([]);
    expect(kerjanNextStatuses("ready_for_qa")).toEqual([]);
  });

  it("names comment authors from the member list", () => {
    const thread = kerjanThread(
      [
        {
          id: 1,
          author_id: 35,
          body: "hi",
          created_at: "2026-10-10T00:00:00Z",
        },
        {
          id: 2,
          author_id: 99,
          body: "yo",
          created_at: "2026-10-10T00:00:00Z",
        },
      ],
      new Map([[35, "Abdul"]]),
    );
    expect(thread.comments.map((comment) => comment.author)).toEqual([
      "Abdul",
      "Member 99",
    ]);
  });
});

describe("kerjan fetching", () => {
  beforeEach(() => {
    clearKerjanCache();
    vi.mocked(invoke).mockReset();
  });

  it("lists every task assigned to the member", async () => {
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { tool, arguments: input } = args as {
        tool: string;
        arguments: Record<string, unknown>;
      };
      if (tool === "list_members") return [];
      if (tool === "list_sprints") return [];
      if (tool === "list_tickets") {
        expect(input).toEqual({ assignee_id: 27 });
        return [
          ticket(),
          ticket({ key: "PRD-1", status: "done" }),
          ticket({ key: "PRD-2", status: "canceled" }),
        ];
      }
      throw new Error(`unexpected ${tool}`);
    });
    const issues = await listKerjanIssues({ assignedToMe: true, memberId: 27 });
    expect(issues.map((issue) => issue.stateType)).toEqual([
      "todo",
      "done",
      "canceled",
    ]);
  });

  it("lists stories of active sprints only", async () => {
    const sprintIds: unknown[] = [];
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { tool, arguments: input } = args as {
        tool: string;
        arguments: Record<string, unknown>;
      };
      if (tool === "list_members") return [];
      if (tool === "list_sprints") {
        return [
          { id: 1, name: "A", state: "active" },
          { id: 2, name: "B", state: "planned" },
        ];
      }
      if (tool === "list_tickets") {
        sprintIds.push(input.sprint_id);
        return [ticket({ kind: "story", sprint_id: 1 })];
      }
      throw new Error(`unexpected ${tool}`);
    });
    await listKerjanIssues({ assignedToMe: false, memberId: 27 });
    expect(sprintIds).toEqual([1]);
  });

  it("shares one get_ticket between details and thread", async () => {
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const { tool } = args as { tool: string };
      if (tool === "list_members") return [{ id: 27, name: "Ridho" }];
      if (tool === "get_ticket") {
        calls += 1;
        return {
          ticket: ticket({ description: "Scope", created_by: 27 }),
          comments: [
            { id: 1, author_id: 27, body: "done", created_at: "2026-10-10" },
          ],
        };
      }
      throw new Error(`unexpected ${tool}`);
    });
    const [details, thread] = await Promise.all([
      kerjanTicketDetails("PRD-575", { force: true }),
      kerjanTicketThread("PRD-575", { force: true }),
    ]);
    expect(calls).toBe(1);
    expect(details).toMatchObject({ body: "Scope", author: "Ridho" });
    expect(thread.comments[0]?.author).toBe("Ridho");
  });
});

describe("kerjan filters", () => {
  const sprints = new Map([[91, "Sprint 1"]]);
  const items = [
    kerjanTicketToIssue(ticket({ key: "PRD-1" }), new Map(), sprints),
    kerjanTicketToIssue(
      ticket({ key: "PRD-2", status: "done", sprint_id: null }),
      new Map(),
      sprints,
    ),
    kerjanTicketToIssue(
      ticket({ key: "PRD-3", status: "canceled" }),
      new Map(),
      sprints,
    ),
  ];

  async function shown(
    overrides: Partial<import("./inboxFilters").InboxFilters>,
  ) {
    const { applyInboxFilters, DEFAULT_INBOX_FILTERS } =
      await import("./inboxFilters");
    return applyInboxFilters(
      items,
      { ...DEFAULT_INBOX_FILTERS, ...overrides },
      "",
      Date.now(),
      "kerjan",
    ).map((item) => item.identifier);
  }

  it("hides only canceled tickets when nothing is selected", async () => {
    expect(await shown({})).toEqual(["PRD-1", "PRD-2"]);
  });

  it("treats a ticket with canceled_at as canceled whatever its status", async () => {
    const issue = kerjanTicketToIssue(
      ticket({
        key: "PRD-4",
        status: "todo",
        canceled_at: "2026-09-25T06:40:15Z",
      }),
      new Map(),
      sprints,
    );
    expect(issue.stateType).toBe("canceled");
    expect(issue.state).toBe("Canceled");
  });

  it("shows exactly the selected statuses", async () => {
    expect(await shown({ kerjanStatuses: ["canceled"] })).toEqual(["PRD-3"]);
    expect(await shown({ kerjanStatuses: ["todo", "done"] })).toEqual([
      "PRD-1",
      "PRD-2",
    ]);
  });

  it("shows exactly the selected sprints", async () => {
    const { linearProjectOptions } = await import("./inboxFilters");
    expect(linearProjectOptions(items, "kerjan")).toEqual([
      { id: "91", name: "Sprint 1" },
      { id: "~none", name: "No sprint" },
    ]);
    expect(await shown({ kerjanSprints: ["~none"] })).toEqual(["PRD-2"]);
    expect(await shown({ kerjanSprints: ["91"] })).toEqual(["PRD-1"]);
  });

  it("treats the defaults as no active filter", async () => {
    const { DEFAULT_INBOX_FILTERS, hasActiveInboxFilters } =
      await import("./inboxFilters");
    expect(hasActiveInboxFilters(DEFAULT_INBOX_FILTERS, "kerjan")).toBe(false);
    expect(
      hasActiveInboxFilters(
        { ...DEFAULT_INBOX_FILTERS, kerjanEveryone: true },
        "kerjan",
      ),
    ).toBe(true);
    expect(
      hasActiveInboxFilters(
        { ...DEFAULT_INBOX_FILTERS, kerjanStatuses: ["done"] },
        "kerjan",
      ),
    ).toBe(true);
  });
});
