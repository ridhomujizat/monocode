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

export type ProjectGroupMember = {
  /** Unique per membership: the same path may live in several groups. */
  id: string;
  path: string;
};

export type ProjectGroup = {
  id: string;
  name: string;
  /** Normalized project paths, deduped by path key within the group. */
  members: ProjectGroupMember[];
  collapsed: boolean;
  /** Pinned groups render inside the Pinned section, above pinned projects. */
  pinned?: boolean;
  /** Palette index from `TAB_GROUP_COLORS`. Missing or 0 is the default wash. */
  colorIndex?: number;
  /** Custom hex from the group color picker. Wins over `colorIndex`. */
  customColor?: string;
};

export type ProjectGroupEntry =
  | {
      kind: "group";
      group: ProjectGroup;
      /** Resolved members, aligned by index with `projects`. */
      members: ProjectGroupMember[];
      projects: RecentProject[];
    }
  | { kind: "project"; project: RecentProject };

type StoredGroup = {
  id?: unknown;
  name?: unknown;
  members?: unknown;
  /** Legacy shape (pre-uuid memberships). */
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
    group.members.some((member) => sameProjectPath(member.path, path)),
  );
}

/** Every group holding the path — a path may join several groups. */
export function groupsContaining(
  groups: ProjectGroup[],
  path: string,
): ProjectGroup[] {
  return groups.filter((group) =>
    group.members.some((member) => sameProjectPath(member.path, path)),
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
    members: [],
    collapsed: false,
  };
  return { groups: [group, ...groups], id };
}

export function createGroupWithProjects(
  groups: ProjectGroup[],
  paths: string[],
  name?: string,
): { groups: ProjectGroup[]; id: string } {
  const members = pathsToMembers(paths);
  if (members.length === 0) return { groups, id: "" };
  const id = crypto.randomUUID();
  const group: ProjectGroup = {
    id,
    name: name ?? uniqueGroupName(groups),
    members,
    collapsed: false,
  };
  return { groups: [group, ...groups], id };
}

/**
 * Joining a group never pulls the path out of other groups — one folder may
 * live in several groups at once. Joining twice within one group is a no-op.
 */
export function addProjectToGroup(
  groups: ProjectGroup[],
  groupId: string,
  path: string,
): ProjectGroup[] {
  if (!path || !groups.some((group) => group.id === groupId)) return groups;
  const target = groups.find((group) => group.id === groupId);
  if (target?.members.some((member) => sameProjectPath(member.path, path))) {
    return groups;
  }
  return groups.map((group) =>
    group.id === groupId
      ? { ...group, members: [...group.members, makeMember(path)] }
      : group,
  );
}

/** Removes every membership of the path across all groups. */
export function removeProjectFromGroup(
  groups: ProjectGroup[],
  path: string,
): ProjectGroup[] {
  let changed = false;
  const next = groups.map((group) => {
    if (!group.members.some((member) => sameProjectPath(member.path, path))) {
      return group;
    }
    changed = true;
    return {
      ...group,
      members: group.members.filter(
        (member) => !sameProjectPath(member.path, path),
      ),
    };
  });
  return changed ? next : groups;
}

/** Removes a single membership by id (dragging a card out of its group). */
export function removeMembership(
  groups: ProjectGroup[],
  memberId: string,
): ProjectGroup[] {
  let changed = false;
  const next = groups.map((group) => {
    if (!group.members.some((member) => member.id === memberId)) return group;
    changed = true;
    return {
      ...group,
      members: group.members.filter((member) => member.id !== memberId),
    };
  });
  return changed ? next : groups;
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
    entry.id === groupId ? { ...withoutColors(entry), customColor: hex } : entry,
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
  const members = pathsToMembers(paths).map((member) => {
    // Keep the membership id when the path already belongs to the group so
    // drag identities survive plain reorders.
    const existing = group.members.find((entry) =>
      sameProjectPath(entry.path, member.path),
    );
    return existing ? { ...existing, path: member.path } : member;
  });
  if (
    members.length === group.members.length &&
    members.every((member, index) =>
      sameProjectPath(member.path, group.members[index].path),
    )
  ) {
    return groups;
  }
  return groups.map((entry) =>
    entry.id === groupId ? { ...entry, members } : entry,
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
  return groups.map((group) => (idSet.has(group.id) ? ordered[next++]! : group));
}

/**
 * Groups in stored order, each resolving its members to known projects in
 * member order; then the remaining projects in rail order. A project held by
 * several groups appears in each of them. Pinned projects belong to the
 * Pinned section only, and groups render even when empty.
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
    for (const member of group.members) grouped.add(pathKey(member.path));
  }
  const entries: ProjectGroupEntry[] = [];
  for (const group of groups) {
    const members: ProjectGroupMember[] = [];
    const resolved: RecentProject[] = [];
    for (const member of group.members) {
      const key = pathKey(member.path);
      if (pinned.has(key)) continue;
      const project = byKey.get(key);
      if (!project) continue;
      members.push(member);
      resolved.push(project);
    }
    entries.push({ kind: "group", group, members, projects: resolved });
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
    const members = group.members.filter((member) =>
      known.has(pathKey(member.path)),
    );
    if (members.length !== group.members.length) {
      changed = true;
      next.push({ ...group, members });
    } else {
      next.push(group);
    }
  }
  return changed ? next : groups;
}

const ARCHIVED_KEY = "monocode.archivedGroups";

/** Removes the group from the active list so it can be parked in the archive. */
export function archiveGroup(
  groups: ProjectGroup[],
  groupId: string,
): { groups: ProjectGroup[]; archived: ProjectGroup | null } {
  const archived = groups.find((group) => group.id === groupId);
  if (!archived) return { groups, archived: null };
  return { groups: groups.filter((group) => group.id !== groupId), archived };
}

/** Moves an archived group back into the active list (prepended). */
export function restoreGroup(
  archived: ProjectGroup[],
  groupId: string,
): { archived: ProjectGroup[]; group: ProjectGroup | null } {
  const group = archived.find((entry) => entry.id === groupId);
  if (!group) return { archived, group: null };
  return {
    archived: archived.filter((entry) => entry.id !== groupId),
    group,
  };
}

export function loadArchivedGroups(): ProjectGroup[] {
  try {
    const raw = localStorage.getItem(ARCHIVED_KEY);
    if (!raw) return [];
    return parseGroups(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveArchivedGroups(groups: ProjectGroup[]): void {
  try {
    if (groups.length === 0) {
      localStorage.removeItem(ARCHIVED_KEY);
      return;
    }
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify(groups));
  } catch {
    // private mode / quota
  }
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
  const members = parseMembers(rec);
  if (members == null) return null;
  const customColor = parseCustomHex(
    typeof rec.customColor === "string" ? rec.customColor : null,
  );
  const colorIndex = sanitizeColorIndex(
    typeof rec.colorIndex === "number" ? rec.colorIndex : null,
  );
  return {
    id: rec.id,
    name,
    members,
    collapsed: rec.collapsed === true,
    ...(rec.pinned === true ? { pinned: true } : {}),
    ...(customColor != null
      ? { customColor }
      : colorIndex != null
        ? { colorIndex }
        : {}),
  };
}

/** Accepts uuid memberships and migrates the legacy `paths` string array. */
function parseMembers(rec: StoredGroup): ProjectGroupMember[] | null {
  if (Array.isArray(rec.members)) {
    const seen = new Set<string>();
    const out: ProjectGroupMember[] = [];
    for (const item of rec.members) {
      if (!item || typeof item !== "object") continue;
      const member = item as { id?: unknown; path?: unknown };
      if (typeof member.path !== "string" || !member.path) continue;
      const key = pathKey(member.path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id:
          typeof member.id === "string" && member.id
            ? member.id
            : crypto.randomUUID(),
        path: normalizeProjectPath(member.path),
      });
    }
    return out;
  }
  if (Array.isArray(rec.paths)) {
    return pathsToMembers(
      rec.paths.filter(
        (path): path is string => typeof path === "string" && !!path,
      ),
    );
  }
  return null;
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

function makeMember(path: string): ProjectGroupMember {
  return { id: crypto.randomUUID(), path: normalizeProjectPath(path) };
}

function pathsToMembers(paths: string[]): ProjectGroupMember[] {
  const seen = new Set<string>();
  const out: ProjectGroupMember[] = [];
  for (const path of paths) {
    const key = pathKey(path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(makeMember(path));
  }
  return out;
}
