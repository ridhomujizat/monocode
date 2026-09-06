import { isHexColor } from "./colorUtils";
import { pathKey } from "./paths";
import {
  normalizeProjectPath,
  sameProjectPath,
  type RecentProject,
} from "./recents";
import { orderByIds } from "./reorder";

import { TAB_GROUP_COLORS } from "./tabGroups";

const KEY = "monocode.projectGroups";
/** Flat-order marker that starts the ungrouped run (see splitUnifiedOrder). */
export const UNGROUPED_MARKER = "ungrouped";

export type ProjectGroup = {
  id: string;
  name: string;
  /** Normalized project paths, deduped by path key. */
  paths: string[];
  collapsed: boolean;
  /** Pinned groups render inside the Pinned section, above pinned projects. */
  pinned?: boolean;
  /** Palette index from `TAB_GROUP_COLORS`. Missing or 0 is the default wash. */
  colorIndex?: number;
  /** Custom hex from the group color picker. Wins over `colorIndex`. */
  customColor?: string;
};

export type ProjectGroupEntry =
  | { kind: "group"; group: ProjectGroup; projects: RecentProject[] }
  | { kind: "project"; project: RecentProject };

type StoredGroup = {
  id?: unknown;
  name?: unknown;
  paths?: unknown;
  collapsed?: unknown;
  pinned?: unknown;
  colorIndex?: unknown;
  customColor?: unknown;
};

export function groupContaining(
  groups: ProjectGroup[],
  path: string,
): ProjectGroup | undefined {
  return groups.find((group) =>
    group.paths.some((member) => sameProjectPath(member, path)),
  );
}

export function uniqueGroupName(
  groups: ProjectGroup[],
  base = "New group",
): string {
  const names = new Set(groups.map((group) => group.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** Create an empty group; members are dragged in or added afterwards. */
export function createGroup(
  groups: ProjectGroup[],
  name?: string,
): { groups: ProjectGroup[]; id: string } {
  const id = crypto.randomUUID();
  const group: ProjectGroup = {
    id,
    name: name ?? uniqueGroupName(groups),
    paths: [],
    collapsed: false,
  };
  return { groups: [group, ...groups], id };
}

export function createGroupWithProjects(
  groups: ProjectGroup[],
  paths: string[],
  name?: string,
): { groups: ProjectGroup[]; id: string } {
  const members = uniquePaths(paths);
  if (members.length === 0) return { groups, id: "" };
  const next = removeProjects(groups, members);
  const id = crypto.randomUUID();
  const group: ProjectGroup = {
    id,
    name: name ?? uniqueGroupName(next),
    paths: members,
    collapsed: false,
  };
  return { groups: [group, ...next], id };
}

export function addProjectToGroup(
  groups: ProjectGroup[],
  groupId: string,
  path: string,
): ProjectGroup[] {
  if (!path || !groups.some((group) => group.id === groupId)) return groups;
  const current = groupContaining(groups, path);
  if (current?.id === groupId) return groups;
  return groups.map((group) => {
    if (group.id === groupId) {
      return {
        ...group,
        paths: [...group.paths, normalizeProjectPath(path)],
      };
    }
    if (!group.paths.some((member) => sameProjectPath(member, path))) {
      return group;
    }
    return {
      ...group,
      paths: group.paths.filter((member) => !sameProjectPath(member, path)),
    };
  });
}

export function removeProjectFromGroup(
  groups: ProjectGroup[],
  path: string,
): ProjectGroup[] {
  if (!groupContaining(groups, path)) return groups;
  return groups.map((group) =>
    group.paths.some((member) => sameProjectPath(member, path))
      ? {
          ...group,
          paths: group.paths.filter(
            (member) => !sameProjectPath(member, path),
          ),
        }
      : group,
  );
}

export function dissolveGroup(
  groups: ProjectGroup[],
  groupId: string,
): ProjectGroup[] {
  if (!groups.some((group) => group.id === groupId)) return groups;
  return groups.filter((group) => group.id !== groupId);
}

export function renameGroup(
  groups: ProjectGroup[],
  groupId: string,
  name: string,
): ProjectGroup[] {
  const trimmed = name.trim();
  if (!trimmed) return groups;
  const group = groups.find((entry) => entry.id === groupId);
  if (!group || group.name === trimmed) return groups;
  return groups.map((entry) =>
    entry.id === groupId ? { ...entry, name: trimmed } : entry,
  );
}

export function setGroupCollapsed(
  groups: ProjectGroup[],
  groupId: string,
  collapsed: boolean,
): ProjectGroup[] {
  const group = groups.find((entry) => entry.id === groupId);
  if (!group || group.collapsed === collapsed) return groups;
  return groups.map((entry) =>
    entry.id === groupId ? { ...entry, collapsed } : entry,
  );
}

export function setGroupPinned(
  groups: ProjectGroup[],
  groupId: string,
  pinned: boolean,
): ProjectGroup[] {
  const group = groups.find((entry) => entry.id === groupId);
  if (!group || group.pinned === pinned) return groups;
  return groups.map((entry) =>
    entry.id === groupId ? { ...entry, pinned } : entry,
  );
}
export function setGroupColor(
  groups: ProjectGroup[],
  groupId: string,
  colorIndex: number | null,
): ProjectGroup[] {
  const group = groups.find((entry) => entry.id === groupId);
  const nextIndex = sanitizeColorIndex(colorIndex);
  if (!group || (group.colorIndex === nextIndex && group.customColor == null)) {
    return groups;
  }
  return groups.map((entry) => {
    if (entry.id !== groupId) return entry;
    const next = withoutColors(entry);
    return nextIndex == null ? next : { ...next, colorIndex: nextIndex };
  });
}

export function setGroupCustomColor(
  groups: ProjectGroup[],
  groupId: string,
  color: string | null,
): ProjectGroup[] {
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) return groups;
  if (color == null) {
    if (group.customColor == null) return groups;
    return groups.map((entry) =>
      entry.id === groupId ? withoutColors(entry) : entry,
    );
  }
  const hex = parseCustomHex(color);
  if (hex == null) return groups;
  if (group.customColor === hex && group.colorIndex == null) return groups;
  return groups.map((entry) =>
    entry.id === groupId
      ? { ...withoutColors(entry), customColor: hex }
      : entry,
  );
}

/** Replace a group's member order; groups may be empty. */
export function setGroupProjects(
  groups: ProjectGroup[],
  groupId: string,
  paths: string[],
): ProjectGroup[] {
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) return groups;
  const members = uniquePaths(paths);
  if (
    members.length === group.paths.length &&
    members.every((path, index) => sameProjectPath(path, group.paths[index]))
  ) {
    return groups;
  }
  return groups.map((entry) =>
    entry.id === groupId ? { ...entry, paths: members } : entry,
  );
}

/** Reorder only the named groups; anything else keeps its slot. */
export function reorderGroupContainers(
  groups: ProjectGroup[],
  ids: string[],
): ProjectGroup[] {
  const idSet = new Set(ids);
  const moving = groups.filter((group) => idSet.has(group.id));
  const ordered = orderByIds(moving, ids);
  if (
    ordered.length !== moving.length ||
    ordered.every((group, index) => group.id === moving[index]?.id)
  ) {
    return groups;
  }
  let next = 0;
  return groups.map((group) =>
    idSet.has(group.id) ? ordered[next++]! : group,
  );
}

/**
 * Groups in stored order, each resolving its members to known projects in
 * `paths` order; then the remaining projects in rail order. Pinned projects
 * belong to the Pinned section only, and empty groups are skipped.
 */
export function buildProjectGroupEntries(
  projects: RecentProject[],
  groups: ProjectGroup[],
  pinnedPaths: string[],
): ProjectGroupEntry[] {
  const byKey = new Map(
    projects.map((project) => [pathKey(project.path), project]),
  );
  const pinned = new Set(pinnedPaths.map(pathKey));
  const grouped = new Set<string>();
  for (const group of groups) {
    for (const path of group.paths) grouped.add(pathKey(path));
  }
  const entries: ProjectGroupEntry[] = [];
  for (const group of groups) {
    const members: RecentProject[] = [];
    for (const path of group.paths) {
      const key = pathKey(path);
      if (pinned.has(key)) continue;
      const project = byKey.get(key);
      if (project) members.push(project);
    }
    entries.push({ kind: "group", group, projects: members });
  }
  for (const project of projects) {
    const key = pathKey(project.path);
    if (pinned.has(key) || grouped.has(key)) continue;
    entries.push({ kind: "project", project });
  }
  return entries;
}

/**
 * Parse the unified drag order: `group:<id>` ids start a group run, cards
 * before the first marker join the first group at its start, the ungrouped
 * marker ends the last group run and everything after it is ungrouped, and
 * with no markers everything is ungrouped.
 */
export function splitUnifiedOrder(ids: string[]): {
  groupOrders: Array<{ groupId: string; paths: string[] }>;
  ungrouped: string[];
} {
  const runs: Array<{ groupId: string; paths: string[] }> = [];
  const byId = new Map<string, string[]>();
  const ungrouped: string[] = [];
  let current: string[] | null = null;
  let lead: string[] | null = null;
  let inUngrouped = false;
  for (const id of ids) {
    if (id === UNGROUPED_MARKER) {
      inUngrouped = true;
      current = null;
      continue;
    }
    if (id.startsWith("group:")) {
      const groupId = id.slice("group:".length);
      let paths = byId.get(groupId);
      if (!paths) {
        paths = [];
        byId.set(groupId, paths);
        runs.push({ groupId, paths });
      }
      current = paths;
      continue;
    }
    if (inUngrouped) {
      ungrouped.push(id);
      continue;
    }
    if (current) {
      current.push(id);
    } else {
      lead ??= [];
      lead.push(id);
    }
  }
  if (lead && runs.length > 0) {
    runs[0]!.paths.unshift(...lead);
  }
  return {
    groupOrders: runs.map(({ groupId, paths }) => ({ groupId, paths })),
    ungrouped: [...(runs.length === 0 ? (lead ?? []) : []), ...ungrouped],
  };
}

export function pruneProjectGroups(
  groups: ProjectGroup[],
  knownPaths: ReadonlySet<string>,
): ProjectGroup[] {
  const known = new Set<string>();
  for (const path of knownPaths) known.add(pathKey(path));
  let changed = false;
  const next: ProjectGroup[] = [];
  for (const group of groups) {
    const paths = group.paths.filter((path) => known.has(pathKey(path)));
    if (paths.length !== group.paths.length) {
      changed = true;
      next.push({ ...group, paths });
    } else {
      next.push(group);
    }
  }
  return changed ? next : groups;
}

export function loadProjectGroups(): ProjectGroup[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return parseGroups(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveProjectGroups(groups: ProjectGroup[]): void {
  try {
    if (groups.length === 0) {
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(groups));
  } catch {
    // private mode / quota
  }
}

function parseGroups(value: unknown): ProjectGroup[] {
  if (!Array.isArray(value)) return [];
  const out: ProjectGroup[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const group = parseGroup(item);
    if (!group || seen.has(group.id)) continue;
    seen.add(group.id);
    out.push(group);
  }
  return out;
}

function parseGroup(value: unknown): ProjectGroup | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as StoredGroup;
  if (typeof rec.id !== "string" || !rec.id) return null;
  if (typeof rec.name !== "string") return null;
  const name = rec.name.trim();
  if (!name) return null;
  if (!Array.isArray(rec.paths)) return null;
  const paths = uniquePaths(
    rec.paths.filter(
      (path): path is string => typeof path === "string" && !!path,
    ),
  );
  const customColor = parseCustomHex(
    typeof rec.customColor === "string" ? rec.customColor : null,
  );
  const colorIndex = sanitizeColorIndex(
    typeof rec.colorIndex === "number" ? rec.colorIndex : null,
  );
  return {
    id: rec.id,
    name,
    paths,
    collapsed: rec.collapsed === true,
    ...(rec.pinned === true ? { pinned: true } : {}),
    ...(customColor != null
      ? { customColor }
      : colorIndex != null
        ? { colorIndex }
        : {}),
  };
}

function sanitizeColorIndex(colorIndex: number | null): number | undefined {
  if (
    colorIndex == null ||
    !Number.isInteger(colorIndex) ||
    colorIndex <= 0 ||
    colorIndex >= TAB_GROUP_COLORS.length
  ) {
    return undefined;
  }
  return colorIndex;
}

function parseCustomHex(color: string | null | undefined): string | undefined {
  if (typeof color !== "string" || !isHexColor(color)) return undefined;
  return color.toLowerCase();
}

function withoutColors(group: ProjectGroup): ProjectGroup {
  const { colorIndex: _index, customColor: _custom, ...rest } = group;
  return rest;
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = pathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeProjectPath(path));
  }
  return out;
}

function removeProjects(
  groups: ProjectGroup[],
  paths: string[],
): ProjectGroup[] {
  const drop = new Set(paths.map(pathKey));
  return groups.map((group) => {
    if (!group.paths.some((member) => drop.has(pathKey(member)))) return group;
    return {
      ...group,
      paths: group.paths.filter((member) => !drop.has(pathKey(member))),
    };
  });
}

