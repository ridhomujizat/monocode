import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProjectToGroup,
  buildProjectGroupEntries,
  createGroupWithProjects,
  dissolveGroup,
  groupContaining,
  loadProjectGroups,
  pruneProjectGroups,
  removeProjectFromGroup,
  renameGroup,
  reorderGroupContainers,
  saveProjectGroups,
  setGroupCollapsed,
  setGroupColor,
  setGroupCustomColor,
  setGroupPinned,
  setGroupProjects,
  splitUnifiedOrder,
  UNGROUPED_MARKER,
  uniqueGroupName,
  type ProjectGroup,
} from "./projectGroups";
import type { RecentProject } from "./recents";

const KEY = "monocode.projectGroups";

function project(path: string, openedAt = 1): RecentProject {
  return { path, openedAt };
}

function group(
  id: string,
  paths: string[],
  overrides: Partial<ProjectGroup> = {},
): ProjectGroup {
  return {
    id,
    name: id,
    paths,
    collapsed: false,
    ...overrides,
  };
}

function mockLocalStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("uniqueGroupName", () => {
  it("uses New group, then numbers", () => {
    expect(uniqueGroupName([])).toBe("New group");
    expect(uniqueGroupName([group("a", ["/p"], { name: "New group" })])).toBe(
      "New group 2",
    );
    expect(
      uniqueGroupName([
        group("a", ["/p"], { name: "New group" }),
        group("b", ["/q"], { name: "New group 2" }),
      ]),
    ).toBe("New group 3");
  });
});

describe("groupContaining", () => {
  it("matches modulo trailing slashes", () => {
    const groups = [group("g", ["/tmp/one"])];
    expect(groupContaining(groups, "/tmp/one/")?.id).toBe("g");
    expect(groupContaining(groups, "/tmp/two")).toBeUndefined();
  });
});

describe("createGroupWithProjects", () => {
  it("prepends the new group", () => {
    const start = [group("a", ["/p/a"])];
    const { groups, id } = createGroupWithProjects(start, ["/p/b"], "Work");
    expect(groups.map((entry) => entry.id)).toEqual([id, "a"]);
    expect(groups[0]).toMatchObject({ name: "Work", paths: ["/p/b"] });
  });

  it("dedupes paths", () => {
    const { groups, id } = createGroupWithProjects(
      [],
      ["/p/a/", "/p/a", "/p/b"],
    );
    expect(groups.find((entry) => entry.id === id)?.paths).toEqual([
      "/p/a",
      "/p/b",
    ]);
  });

  it("pulls projects out of their previous groups and dissolves emptied ones", () => {
    const start = [group("g1", ["/p/a"]), group("g2", ["/p/b", "/p/c"])];
    const { groups, id } = createGroupWithProjects(start, ["/p/a", "/p/b"]);
    expect(groups.map((entry) => entry.id)).toEqual([id, "g2"]);
    expect(groups[0]?.paths).toEqual(["/p/a", "/p/b"]);
    expect(groups[1]?.paths).toEqual(["/p/c"]);
  });

  it("returns no id for empty paths", () => {
    const start = [group("a", ["/p/a"])];
    const { groups, id } = createGroupWithProjects(start, []);
    expect(id).toBe("");
    expect(groups).toBe(start);
  });
});

describe("addProjectToGroup", () => {
  it("moves a project between groups, dissolving the emptied source", () => {
    const start = [group("g1", ["/p/a"]), group("g2", ["/p/b"])];
    const next = addProjectToGroup(start, "g2", "/p/a");
    expect(next.map((entry) => entry.id)).toEqual(["g2"]);
    expect(next[0]?.paths).toEqual(["/p/b", "/p/a"]);
  });

  it("returns the same reference for an unknown group or an existing member", () => {
    const start = [group("g1", ["/p/a"])];
    expect(addProjectToGroup(start, "nope", "/p/a")).toBe(start);
    expect(addProjectToGroup(start, "g1", "/p/a")).toBe(start);
    expect(addProjectToGroup(start, "g1", "")).toBe(start);
  });
});

describe("removeProjectFromGroup", () => {
  it("drops the group when it empties", () => {
    expect(removeProjectFromGroup([group("g", ["/p/a"])], "/p/a")).toEqual([]);
    const start = [group("g", ["/p/a", "/p/b"])];
    const next = removeProjectFromGroup(start, "/p/a");
    expect(next).toEqual([group("g", ["/p/b"])]);
  });

  it("returns the same reference when the project is ungrouped", () => {
    const start = [group("g", ["/p/a"])];
    expect(removeProjectFromGroup(start, "/p/b")).toBe(start);
  });
});

describe("setGroupProjects", () => {
  it("replaces member order with normalized deduped paths", () => {
    const start = [group("g", ["/p/a", "/p/b"])];
    const next = setGroupProjects(start, "g", ["/p/b/", "/p/a", "/p/b"]);
    expect(next[0]?.paths).toEqual(["/p/b", "/p/a"]);
  });

  it("returns the same reference when nothing changes", () => {
    const start = [group("g", ["/p/a", "/p/b"])];
    expect(setGroupProjects(start, "g", ["/p/a/", "/p/b"])).toBe(start);
    expect(setGroupProjects(start, "nope", ["/p/a"])).toBe(start);
  });

  it("drops the group when the result is empty", () => {
    const start = [group("g1", ["/p/a"]), group("g2", ["/p/b"])];
    const next = setGroupProjects(start, "g1", []);
    expect(next).toEqual([group("g2", ["/p/b"])]);
  });
});

describe("pruneProjectGroups", () => {
  it("drops unknown paths and emptied groups", () => {
    const start = [
      group("g1", ["/p/a", "/gone"]),
      group("g2", ["/gone2"]),
      group("g3", ["/p/b"]),
    ];
    const next = pruneProjectGroups(start, new Set(["/p/a", "/p/b"]));
    expect(next).toEqual([group("g1", ["/p/a"]), group("g3", ["/p/b"])]);
  });

  it("returns the same reference when nothing is stale", () => {
    const start = [group("g", ["/p/a"])];
    expect(pruneProjectGroups(start, new Set(["/p/a", "/p/b"]))).toBe(start);
  });
});

describe("dissolveGroup", () => {
  it("removes only the named group", () => {
    const start = [group("g1", ["/p/a"]), group("g2", ["/p/b"])];
    expect(dissolveGroup(start, "g1")).toEqual([group("g2", ["/p/b"])]);
    expect(dissolveGroup(start, "nope")).toBe(start);
  });
});

describe("renameGroup", () => {
  it("renames and ignores empty or unchanged names", () => {
    const start = [group("g", ["/p/a"], { name: "Work" })];
    expect(renameGroup(start, "g", " Personal ")[0]?.name).toBe("Personal");
    expect(renameGroup(start, "g", "  ")).toBe(start);
    expect(renameGroup(start, "g", "Work")).toBe(start);
    expect(renameGroup(start, "nope", "X")).toBe(start);
  });
});

describe("setGroupCollapsed", () => {
  it("toggles and ignores unchanged state", () => {
    const start = [group("g", ["/p/a"])];
    expect(setGroupCollapsed(start, "g", true)[0]?.collapsed).toBe(true);
    expect(setGroupCollapsed(start, "g", false)).toBe(start);
    expect(setGroupCollapsed(start, "nope", true)).toBe(start);
  });
});

describe("setGroupPinned", () => {
  it("toggles and ignores unchanged state", () => {
    const start = [group("g", ["/p/a"])];
    expect(setGroupPinned(start, "g", true)).toEqual([
      group("g", ["/p/a"], { pinned: true }),
    ]);
    const pinned = setGroupPinned(start, "g", true);
    expect(setGroupPinned(pinned, "g", true)).toBe(pinned);
    expect(setGroupPinned(start, "nope", true)).toBe(start);
  });
});

describe("group colors", () => {
  it("sets a palette index and clears custom colors", () => {
    const start = [
      group("g", ["/p/a"], { colorIndex: 2, customColor: "#ff00aa" }),
    ];
    const next = setGroupColor(start, "g", 4);
    expect(next[0]).toEqual(group("g", ["/p/a"], { colorIndex: 4 }));
    expect(setGroupColor(start, "g", 0)).toEqual([group("g", ["/p/a"])]);
    expect(setGroupColor(start, "g", 99)).toEqual([group("g", ["/p/a"])]);
  });

  it("sets a custom hex that wins over the palette index", () => {
    const start = [group("g", ["/p/a"], { colorIndex: 4 })];
    expect(setGroupCustomColor(start, "g", "#AABBCC")[0]).toEqual(
      group("g", ["/p/a"], { customColor: "#aabbcc" }),
    );
    expect(setGroupCustomColor(start, "g", "red")).toBe(start);
    expect(setGroupCustomColor(start, "g", null)).toBe(start);
  });
});

describe("reorderGroupContainers", () => {
  it("reorders only the named groups", () => {
    const start = [
      group("g1", ["/p/a"]),
      group("g2", ["/p/b"]),
      group("g3", ["/p/c"]),
    ];
    const next = reorderGroupContainers(start, ["g3", "g1"]);
    expect(next.map((entry) => entry.id)).toEqual(["g3", "g2", "g1"]);
    expect(reorderGroupContainers(start, ["g1", "g2", "g3"])).toBe(start);
  });
});

describe("buildProjectGroupEntries", () => {
  it("lists groups in stored order, members in path order, then the rest in rail order", () => {
    const projects = [
      project("/p/a"),
      project("/p/b"),
      project("/p/c"),
      project("/p/d"),
      project("/p/e"),
    ];
    const groups = [group("gy", ["/p/b", "/p/a"]), group("gx", ["/p/c"])];
    const entries = buildProjectGroupEntries(projects, groups, []);
    expect(entries).toEqual([
      { kind: "group", group: groups[0], projects: [projects[1], projects[0]] },
      { kind: "group", group: groups[1], projects: [projects[2]] },
      { kind: "project", project: projects[3] },
      { kind: "project", project: projects[4] },
    ]);
  });

  it("excludes pinned projects from groups and ungrouped, skips unknown paths and empty groups", () => {
    const projects = [project("/p/a"), project("/p/b")];
    const groups = [group("g1", ["/p/a", "/gone"]), group("g2", ["/gone2"])];
    const entries = buildProjectGroupEntries(projects, groups, ["/p/a"]);
    expect(entries).toEqual([{ kind: "project", project: projects[1] }]);
  });
});

describe("splitUnifiedOrder", () => {
  it("splits marker runs", () => {
    const { groupOrders, ungrouped } = splitUnifiedOrder([
      "group:g1",
      "/p/a",
      "/p/b",
      "group:g2",
      "/p/c",
      UNGROUPED_MARKER,
      "/p/d",
      "/p/e",
    ]);
    expect(groupOrders).toEqual([
      { groupId: "g1", paths: ["/p/a", "/p/b"] },
      { groupId: "g2", paths: ["/p/c"] },
    ]);
    expect(ungrouped).toEqual(["/p/d", "/p/e"]);
  });

  it("joins pre-marker cards to the first group at its start", () => {
    const { groupOrders, ungrouped } = splitUnifiedOrder([
      "/p/x",
      "group:g1",
      "/p/a",
      UNGROUPED_MARKER,
      "/p/y",
    ]);
    expect(groupOrders).toEqual([{ groupId: "g1", paths: ["/p/x", "/p/a"] }]);
    expect(ungrouped).toEqual(["/p/y"]);
  });

  it("ends the last group run at the ungrouped marker", () => {
    const { groupOrders, ungrouped } = splitUnifiedOrder([
      "group:g1",
      "/p/a",
      UNGROUPED_MARKER,
      "/p/x",
    ]);
    expect(groupOrders).toEqual([{ groupId: "g1", paths: ["/p/a"] }]);
    expect(ungrouped).toEqual(["/p/x"]);
  });

  it("treats everything as ungrouped without group markers", () => {
    expect(splitUnifiedOrder(["/p/a", "/p/b"])).toEqual({
      groupOrders: [],
      ungrouped: ["/p/a", "/p/b"],
    });
    expect(splitUnifiedOrder([UNGROUPED_MARKER, "/p/a"])).toEqual({
      groupOrders: [],
      ungrouped: ["/p/a"],
    });
    expect(splitUnifiedOrder([])).toEqual({ groupOrders: [], ungrouped: [] });
  });
});

describe("project group persistence", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  afterEach(() => {
    mockLocalStorage();
  });

  it("round-trips groups and normalizes paths", () => {
    const groups = [
      group("g", ["/tmp/one/"], { name: "Work", collapsed: true }),
    ];
    saveProjectGroups(groups);
    expect(loadProjectGroups()).toEqual([
      group("g", ["/tmp/one"], { name: "Work", collapsed: true }),
    ]);
  });

  it("round-trips a pinned group and omits the flag when false", () => {
    saveProjectGroups([
      group("g1", ["/p/a"], { pinned: true }),
      group("g2", ["/p/b"]),
    ]);
    expect(loadProjectGroups()).toEqual([
      group("g1", ["/p/a"], { pinned: true }),
      group("g2", ["/p/b"]),
    ]);
    localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "g3", name: "X", paths: ["/p/c"], pinned: "yes" }]),
    );
    expect(loadProjectGroups()).toEqual([group("g3", ["/p/c"], { name: "X" })]);
  });

  it("rejects invalid entries and duplicate ids", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "g1", name: "  ", paths: ["/p/a"] },
        { id: "g2", name: "No paths", paths: [] },
        { id: "g3", name: "Bad paths", paths: ["/p/a", 42, ""] },
        { id: "g3", name: "Duplicate", paths: ["/p/b"] },
        { id: "g4", name: "Kept", paths: ["/p/a"], collapsed: "yes" },
        "junk",
      ]),
    );
    expect(loadProjectGroups()).toEqual([
      group("g3", ["/p/a"], { name: "Bad paths" }),
      group("g4", ["/p/a"], { name: "Kept" }),
    ]);
  });

  it("sanitizes colors on load", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "g1", name: "A", paths: ["/p/a"], customColor: "red" },
        { id: "g2", name: "B", paths: ["/p/b"], colorIndex: 99 },
        { id: "g3", name: "C", paths: ["/p/c"], colorIndex: 4 },
        {
          id: "g4",
          name: "D",
          paths: ["/p/d"],
          colorIndex: 2,
          customColor: "#AABBCC",
        },
      ]),
    );
    expect(loadProjectGroups()).toEqual([
      group("g1", ["/p/a"], { name: "A" }),
      group("g2", ["/p/b"], { name: "B" }),
      group("g3", ["/p/c"], { name: "C", colorIndex: 4 }),
      group("g4", ["/p/d"], { name: "D", customColor: "#aabbcc" }),
    ]);
  });

  it("removes the storage key when the last group is gone and survives corrupt JSON", () => {
    saveProjectGroups([group("g", ["/p/a"])]);
    saveProjectGroups([]);
    expect(localStorage.getItem(KEY)).toBeNull();
    localStorage.setItem(KEY, "{oops");
    expect(loadProjectGroups()).toEqual([]);
  });
});
