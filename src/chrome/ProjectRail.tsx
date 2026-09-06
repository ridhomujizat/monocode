import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Pin,
  PinOff,
  File,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "./icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useDragResize } from "../hooks/useDragResize";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { useProjectDiffStats } from "../hooks/useProjectDiffStats";
import { useSortable } from "../hooks/useSortable";
import { useTabGroupLogos } from "../hooks/useTabGroupLogos";
import {
  loadProjectRailWidth,
  PROJECT_RAIL_WIDTH_DEFAULT,
  PROJECT_RAIL_WIDTH_MAX,
  PROJECT_RAIL_WIDTH_MIN,
  saveProjectRailWidth,
} from "../lib/appearance";
import { basename, revealPath, type GitDiffStats } from "../lib/fs";
import { IS_MAC, IS_WIN, MOD } from "../lib/platform";
import { projectName } from "../lib/paths";
import {
  collectRailProjects,
  loadPinnedProjects,
  loadProjectRailOrder,
  projectRailSections,
  sameProjectPath,
  savePinnedProjects,
  saveProjectRailOrder,
  syncProjectRailOrder,
  type RecentProject,
} from "../lib/recents";
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
  type ProjectGroup,
  type ProjectGroupEntry,
} from "../lib/projectGroups";
import { folderAccent, folderShellFill } from "../lib/sessionFolders";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupColorIndex,
  resolveTabGroupCustomColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
  saveTabGroupColor,
  saveTabGroupCustomColor,
  saveTabGroupLabel,
  saveTabGroupMascot,
} from "../lib/tabGroups";
import { formatLiveElapsed, type LiveAgent } from "../lib/liveAgents";
import { ExplorerMenu, type ExplorerMenuItem } from "./ExplorerMenu";
import { FolderColorSwatches } from "./FolderColorSwatches";
import { HarnessIcon } from "./HarnessIcon";
import { ProjectLogoIcon } from "./ProjectLogoIcon";
import { ProjectMascot } from "./ProjectMascot";
import { RailAction, RailSearch } from "./RailAction";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { SidebarUpdateFooter } from "./SidebarUpdate";
import type { InstalledUpdate } from "../lib/updateNotice";
import { SettingsNav } from "./SettingsRail";
import { Shimmer } from "../surfaces/Shimmer";
import { TabGroupMenu, type TabGroupMenuExtraItem } from "./TabGroupMenu";
import { TerminalSpinner } from "./TerminalSpinner";
import type { SettingsSectionId } from "../lib/settings";

const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : IS_WIN
    ? "Reveal in File Explorer"
    : "Open Containing Folder";

function projectMenuExtraItems(
  pinned: boolean,
  canRemove: boolean,
  memberOfId: string | undefined,
  groups: ProjectGroup[],
): TabGroupMenuExtraItem[] {
  const items: TabGroupMenuExtraItem[] = [
    { id: "group-new", label: "New group", icon: FolderPlus },
    ...(memberOfId
      ? []
      : [
          pinned
            ? { id: "unpin", label: "Unpin project", icon: PinOff }
            : { id: "pin", label: "Pin project", icon: Pin },
        ]),
    { id: "reveal", label: REVEAL_LABEL, icon: FolderOpen },
  ];
  for (const group of groups) {
    if (group.id === memberOfId) continue;
    items.push({
      id: `group-add:${group.id}`,
      label: `Add to ${group.name}`,
      icon: Folder,
    });
  }
  if (memberOfId) {
    items.push({ id: "group-remove", label: "Remove from group", icon: X });
  }
  if (canRemove) {
    items.push(
      { id: "archive", label: "Archive", icon: Archive, sepBefore: true },
      { id: "delete", label: "Delete", icon: Trash2, danger: true },
    );
  }
  return items;
}

type Props = {
  cwd: string;
  recents: RecentProject[];
  inboxUnseen?: boolean;
  busyPaths?: Iterable<string>;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onSearch?: () => void;
  searchActive?: boolean;
  onOpenInbox?: () => void;
  inboxActive?: boolean;
  notesEnabled?: boolean;
  onOpenNotes?: () => void;
  notesActive?: boolean;
  onTogglePanel?: () => void;
  onSelectProject: (path: string) => void;
  onOpenProject: () => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  liveAgents?: LiveAgent[];
  activeSessionId?: string;
  onSelectAgent?: (sessionId: string) => void;
  settingsOpen?: boolean;
  settingsSection?: SettingsSectionId;
  onOpenSettings?: () => void;
  onSelectSettingsSection?: (section: SettingsSectionId) => void;
  onCloseSettings?: () => void;
  updateNotice?: InstalledUpdate | null;
  onOpenWhatsNew?: (version: string) => void;
  onDismissUpdate?: () => void;
};

export function ProjectRail({
  cwd,
  recents,
  inboxUnseen = false,
  busyPaths,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onSearch,
  searchActive = false,
  onOpenInbox,
  inboxActive = false,
  notesEnabled = true,
  onOpenNotes,
  notesActive = false,
  onTogglePanel,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  liveAgents = [],
  activeSessionId,
  onSelectAgent,
  settingsOpen = false,
  settingsSection = "general",
  onOpenSettings,
  onSelectSettingsSection,
  onCloseSettings,
  updateNotice = null,
  onOpenWhatsNew,
  onDismissUpdate,
}: Props) {
  const resize = useDragResize({
    min: PROJECT_RAIL_WIDTH_MIN,
    max: () =>
      Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    defaultWidth: PROJECT_RAIL_WIDTH_DEFAULT,
    initial: loadProjectRailWidth(),
    onCommit: saveProjectRailWidth,
  });
  const [railOrder, setRailOrder] = useState(loadProjectRailOrder);
  const [pinnedPaths, setPinnedPaths] = useState(loadPinnedProjects);
  const [groupLabels, setGroupLabels] = useState(loadTabGroupLabels);
  const [groupColors, setGroupColors] = useState(loadTabGroupColors);
  const [groupMascots, setGroupMascots] = useState(loadTabGroupMascots);
  const [groupCustomColors, setGroupCustomColors] = useState(
    loadTabGroupCustomColors,
  );
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    path: string;
    projectKey: string;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [projectGroups, setProjectGroups] = useState(loadProjectGroups);
  const [groupMenu, setGroupMenu] = useState<{
    x: number;
    y: number;
    groupId: string;
  } | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const groupLogos = useTabGroupLogos();
  const allProjects = useMemo(
    () => collectRailProjects(recents, cwd),
    [cwd, recents],
  );
  const sections = useMemo(
    () => projectRailSections(recents, cwd, railOrder, pinnedPaths),
    [cwd, pinnedPaths, railOrder, recents],
  );
  const groupEntries = useMemo(
    () =>
      buildProjectGroupEntries(sections.projects, projectGroups, pinnedPaths),
    [pinnedPaths, projectGroups, sections.projects],
  );
  const groupBlocks = groupEntries.filter(
    (entry): entry is GroupEntry => entry.kind === "group",
  );
  const pinnedGroupBlocks = groupBlocks.filter((entry) => entry.group.pinned);
  const projectsGroupBlocks = groupBlocks.filter(
    (entry) => !entry.group.pinned,
  );
  const ungroupedProjects = groupEntries
    .filter((entry) => entry.kind === "project")
    .map((entry) => entry.project);
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const path of busyPaths ?? []) set.add(path);
    return set;
  }, [busyPaths]);

  useEffect(() => {
    setRailOrder((prev) => {
      const synced = syncProjectRailOrder(prev, allProjects);
      if (synced.join("\0") === prev.join("\0")) return prev;
      saveProjectRailOrder(synced);
      return synced;
    });
  }, [allProjects]);

  useEffect(() => {
    setPinnedPaths((prev) => {
      const next = prev.filter((path) => allProjects.has(path));
      if (next.length === prev.length) return prev;
      savePinnedProjects(next);
      return next;
    });
  }, [allProjects]);
  useEffect(() => {
    setProjectGroups((current) => {
      const next = pruneProjectGroups(current, new Set(allProjects.keys()));
      if (next === current) return current;
      saveProjectGroups(next);
      return next;
    });
  }, [allProjects]);

  useEffect(() => {
    if (!projectMenu && !groupMenu) return;
    const onScroll = () => {
      setProjectMenu(null);
      setGroupMenu(null);
    };
    const scrollParent = scrollRef.current ?? window;
    scrollParent.addEventListener("scroll", onScroll, true);
    return () => scrollParent.removeEventListener("scroll", onScroll, true);
  }, [projectMenu, groupMenu]);

  const commitProjectGroups = (next: ProjectGroup[]) => {
    setProjectGroups(next);
    saveProjectGroups(next);
  };

  const openProjectMenu = (path: string, x: number, y: number) => {
    setProjectMenu({
      x,
      y,
      path,
      projectKey: projectName(path),
    });
  };

  const onProjectContextMenu = (
    path: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openProjectMenu(path, event.clientX, event.clientY);
  };

  const onProjectRename = (projectKey: string, label: string) => {
    saveTabGroupLabel(projectKey, label);
    setGroupLabels(loadTabGroupLabels());
  };

  const onProjectColorChange = (
    projectKey: string,
    colorIndex: number | null,
  ) => {
    saveTabGroupColor(projectKey, colorIndex);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const onProjectMascotChange = (projectKey: string, name: string | null) => {
    saveTabGroupMascot(projectKey, name);
    setGroupMascots(loadTabGroupMascots());
  };

  const onProjectCustomColorChange = (projectKey: string, color: string) => {
    saveTabGroupCustomColor(projectKey, color);
    setGroupColors(loadTabGroupColors());
    setGroupCustomColors(loadTabGroupCustomColors());
  };

  const reorderSubset = (
    fullOrder: string[],
    subsetOrder: string[],
    subsetPaths: Set<string>,
  ) => {
    const next: string[] = [];
    let subsetIndex = 0;
    for (const path of fullOrder) {
      if (!subsetPaths.has(path)) {
        next.push(path);
        continue;
      }
      if (subsetIndex < subsetOrder.length) {
        next.push(subsetOrder[subsetIndex++]);
      }
    }
    return next;
  };

  const onReorderPinned = (ids: string[]) => {
    const subset = new Set(sections.pinned.map((item) => item.path));
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onFlatReorder = (ids: string[]) => {
    const { groupOrders, ungrouped } = splitUnifiedOrder(ids);
    let next = projectGroups;
    for (const { groupId, paths } of groupOrders) {
      next = setGroupProjects(next, groupId, paths);
    }
    if (next !== projectGroups) commitProjectGroups(next);
    const reordered = reorderSubset(railOrder, ungrouped, new Set(ungrouped));
    if (reordered.join("\0") !== railOrder.join("\0")) {
      setRailOrder(reordered);
      saveProjectRailOrder(reordered);
    }
  };

  const onTogglePin = (path: string) => {
    const isPinned = pinnedPaths.some((pinned) =>
      sameProjectPath(pinned, path),
    );
    const next = isPinned
      ? pinnedPaths.filter((pinned) => !sameProjectPath(pinned, path))
      : [...pinnedPaths, path];
    setPinnedPaths(next);
    savePinnedProjects(next);
    if (!isPinned) {
      commitProjectGroups(removeProjectFromGroup(projectGroups, path));
    }
  };

  /** Group members pin only through their group, so joining unpins. */
  const unpinProject = (path: string) => {
    if (!pinnedPaths.some((pinned) => sameProjectPath(pinned, path))) return;
    const next = pinnedPaths.filter((pinned) => !sameProjectPath(pinned, path));
    setPinnedPaths(next);
    savePinnedProjects(next);
  };

  const onProjectMenuPick = (action: string) => {
    if (!projectMenu) return;
    const { path, projectKey } = projectMenu;
    if (action === "pin" || action === "unpin") onTogglePin(path);
    else if (action === "reveal") void revealPath(path);
    else if (action === "archive") {
      onRemoveProject?.(path, { purgeData: false });
    } else if (action === "delete") {
      setRemoving({
        path,
        name: resolveTabGroupLabel(projectKey, groupLabels, basename(path)),
      });
    } else if (action === "group-new") {
      const { groups, id } = createGroupWithProjects(projectGroups, [path]);
      if (!id) return;
      commitProjectGroups(groups);
      setRenamingGroupId(id);
      unpinProject(path);
    } else if (action.startsWith("group-add:")) {
      const groupId = action.slice("group-add:".length);
      commitProjectGroups(
        setGroupCollapsed(
          addProjectToGroup(projectGroups, groupId, path),
          groupId,
          false,
        ),
      );
      unpinProject(path);
    } else if (action === "group-remove") {
      commitProjectGroups(removeProjectFromGroup(projectGroups, path));
    }
  };

  const onGroupContextMenu = (
    groupId: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectMenu(null);
    setGroupMenu({ x: event.clientX, y: event.clientY, groupId });
  };

  const onGroupMenuPick = (id: string) => {
    if (!groupMenu) return;
    const groupId = groupMenu.groupId;
    setGroupMenu(null);
    if (id === "group-pin") {
      const group = projectGroups.find((entry) => entry.id === groupId);
      commitProjectGroups(
        setGroupPinned(projectGroups, groupId, !group?.pinned),
      );
      return;
    }
    if (id === "rename") {
      setRenamingGroupId(groupId);
      return;
    }
    if (id === "ungroup") {
      commitProjectGroups(dissolveGroup(projectGroups, groupId));
    }
  };

  const onGroupColorChange = (colorIndex: number | null) => {
    if (!groupMenu) return;
    commitProjectGroups(
      setGroupColor(projectGroups, groupMenu.groupId, colorIndex),
    );
  };

  const onGroupCustomColorChange = (color: string) => {
    if (!groupMenu) return;
    commitProjectGroups(
      setGroupCustomColor(projectGroups, groupMenu.groupId, color),
    );
  };

  const menuGroup = groupMenu
    ? projectGroups.find((group) => group.id === groupMenu.groupId)
    : undefined;
  const groupMenuItems: ExplorerMenuItem[] = [
    {
      kind: "item",
      id: "group-pin",
      label: menuGroup?.pinned ? "Unpin group" : "Pin group",
    },
    { kind: "item", id: "rename", label: "Rename", shortcut: "F2" },
    { kind: "sep" },
    { kind: "item", id: "ungroup", label: "Ungroup" },
  ];

  const onConfirmDelete = () => {
    if (!removing) return;
    onRemoveProject?.(removing.path, { purgeData: true });
    setRemoving(null);
  };

  const pinnedIds = sections.pinned.map((item) => item.path);
  const groupIds = [...pinnedGroupBlocks, ...projectsGroupBlocks].map(
    (entry) => entry.group.id,
  );
  const flatIds = [
    ...pinnedGroupBlocks.flatMap((entry) => [
      `group:${entry.group.id}`,
      ...entry.projects.map((project) => project.path),
    ]),
    ...projectsGroupBlocks.flatMap((entry) => [
      `group:${entry.group.id}`,
      ...entry.projects.map((project) => project.path),
    ]),
    UNGROUPED_MARKER,
    ...ungroupedProjects.map((project) => project.path),
  ];
  const pinnedSortable = useSortable(pinnedIds, onReorderPinned, {
    axis: "y",
    onActivate: onSelectProject,
  });
  const cardSortable = useSortable(flatIds, onFlatReorder, {
    axis: "y",
    onActivate: onSelectProject,
    onDropOnGroup: (draggedPath, groupId) => {
      commitProjectGroups(
        setGroupCollapsed(
          addProjectToGroup(projectGroups, groupId, draggedPath),
          groupId,
          false,
        ),
      );
      unpinProject(draggedPath);
    },
  });
  const groupSortable = useSortable(
    groupIds,
    (ids) => commitProjectGroups(reorderGroupContainers(projectGroups, ids)),
    { axis: "y" },
  );

  const renderGroupBlock = (entry: GroupEntry) => {
    const groupId = entry.group.id;
    const expanded = !entry.group.collapsed;
    const groupIndex = groupIds.indexOf(groupId);
    const groupDropTarget =
      cardSortable.dropTarget?.kind === "group" &&
      cardSortable.dropTarget.id === groupId;
    const draggingGroup = groupSortable.draggingId === groupId;
    const showGroupDropStart =
      groupSortable.draggingId &&
      groupSortable.toIndex === groupIndex &&
      groupSortable.fromIndex !== null &&
      groupSortable.toIndex < groupSortable.fromIndex;
    const showGroupDropEnd =
      groupSortable.draggingId &&
      groupSortable.toIndex === groupIndex &&
      groupSortable.fromIndex !== null &&
      groupSortable.toIndex > groupSortable.fromIndex;
    const shellFill = folderShellFill(
      entry.group.colorIndex,
      entry.group.customColor,
    );
    return (
      <div
        key={groupId}
        className={`relative mb-1.5 rounded-md ${draggingGroup ? "opacity-40" : ""}`}
        style={shellFill ? { background: shellFill } : undefined}
      >
        {showGroupDropStart ? (
          <div className="pointer-events-none absolute inset-x-2 top-0 z-20 h-0.5 rounded-full bg-accent" />
        ) : null}
        {showGroupDropEnd ? (
          <div className="pointer-events-none absolute inset-x-2 bottom-0 z-20 h-0.5 rounded-full bg-accent" />
        ) : null}
        {renamingGroupId === groupId ? (
          <ProjectGroupRenameRow
            group={entry.group}
            memberCount={entry.projects.length}
            dropTarget={groupDropTarget}
            dropRef={(el) => cardSortable.setGroupDropRef(groupId, el)}
            onCommit={(name) => {
              commitProjectGroups(renameGroup(projectGroups, groupId, name));
              setRenamingGroupId(null);
            }}
            onCancel={() => setRenamingGroupId(null)}
          />
        ) : (
          <ProjectGroupRow
            group={entry.group}
            count={entry.projects.length}
            expanded={expanded}
            pinned={entry.group.pinned ?? false}
            dropTarget={groupDropTarget}
            canReorder={groupIds.length > 1}
            dropRef={(el) => cardSortable.setGroupDropRef(groupId, el)}
            onPointerDown={(event) =>
              groupSortable.onItemPointerDown(groupId, event)
            }
            onToggle={() => {
              if (groupSortable.consumeClick()) return;
              commitProjectGroups(
                setGroupCollapsed(
                  projectGroups,
                  groupId,
                  !entry.group.collapsed,
                ),
              );
            }}
            onTogglePin={() =>
              commitProjectGroups(
                setGroupPinned(projectGroups, groupId, !entry.group.pinned),
              )
            }
            onContextMenu={(event) => onGroupContextMenu(groupId, event)}
            onRename={() => setRenamingGroupId(groupId)}
          />
        )}
        {expanded ? (
          <div className="mt-px flex flex-col gap-px pl-6">
            {entry.projects.map((project) => (
              <ProjectCard
                key={project.path}
                item={project}
                selected={!searchActive && sameProjectPath(project.path, cwd)}
                busy={isBusyPath(project.path, busy)}
                pinned={false}
                pinnable={false}
                sortable={cardSortable}
                sortIndex={flatIds.indexOf(project.path)}
                onSelect={onSelectProject}
                onTogglePin={onTogglePin}
                onContextMenu={onProjectContextMenu}
                onOpenMenu={openProjectMenu}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderGroupBlocks = (blocks: GroupEntry[]) =>
    blocks.length > 0 ? (
      <div className="flex flex-col gap-px px-2">
        {blocks.map(renderGroupBlock)}
      </div>
    ) : undefined;

  return (
    <nav
      ref={resize.setPaneRef}
      aria-label="Projects"
      className="sidebar-glass relative flex shrink-0 flex-col border-r border-content/10"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center pr-1.5"
        data-tauri-drag-region="deep"
      >
        {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
        <DevModeSlot />
        <TabVisitNav
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={onGoBack}
          onGoForward={onGoForward}
          onTogglePanel={settingsOpen ? undefined : onTogglePanel}
          panelActive
        />
      </div>

      {settingsOpen ? (
        <SettingsNav
          section={settingsSection}
          onSelect={(next) => onSelectSettingsSection?.(next)}
          onClose={() => onCloseSettings?.()}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-px px-2 pb-2 pt-0.5">
            <RailSearch
              label="Search"
              icon={Search}
              onClick={onSearch}
              active={searchActive}
              shortcut={`${MOD}K`}
              ariaLabel={`Search (${MOD}K)`}
            />
            <div className="mt-0.5" />
            <RailAction
              label="Inbox"
              icon={Inbox}
              onClick={onOpenInbox}
              active={inboxActive}
              dot={inboxUnseen}
              ariaLabel={inboxUnseen ? "Inbox, new items" : "Inbox"}
            />
            {notesEnabled ? (
              <RailAction
                label="Notes"
                icon={File}
                onClick={onOpenNotes}
                active={notesActive}
                ariaLabel="Notes"
              />
            ) : null}
          </div>

          <div
            ref={(el) => {
              lockOverscroll(el);
              scrollRef.current = el;
            }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2"
          >
            {sections.pinned.length > 0 || pinnedGroupBlocks.length > 0 ? (
              <ProjectSection
                label="Pinned"
                items={sections.pinned}
                prepend={renderGroupBlocks(pinnedGroupBlocks)}
                cwd={cwd}
                busy={busy}
                sortable={pinnedSortable}
                sortIndexOf={(path) => pinnedIds.indexOf(path)}
                pinned
                searchActive={searchActive || inboxActive || notesActive}
                onSelect={onSelectProject}
                onTogglePin={onTogglePin}
                onContextMenu={onProjectContextMenu}
                onOpenMenu={openProjectMenu}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
              />
            ) : null}

            <ProjectSection
              label="Projects"
              prepend={renderGroupBlocks(projectsGroupBlocks)}
              items={ungroupedProjects}
              emptyLabel="No projects yet"
              onAdd={onOpenProject}
              cwd={cwd}
              busy={busy}
              sortable={cardSortable}
              sortIndexOf={(path) => flatIds.indexOf(path)}
              pinned={false}
              searchActive={searchActive || inboxActive || notesActive}
              onSelect={onSelectProject}
              onTogglePin={onTogglePin}
              onContextMenu={onProjectContextMenu}
              onOpenMenu={openProjectMenu}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupLogos={groupLogos}
              groupMascots={groupMascots}
            />
          </div>
          <LiveAgentsPreview
            agents={liveAgents}
            activeSessionId={activeSessionId}
            onSelect={onSelectAgent}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupMascots={groupMascots}
          />
          <SidebarUpdateFooter
            update={updateNotice}
            onOpenWhatsNew={onOpenWhatsNew}
            onDismissUpdate={onDismissUpdate}
          />
          <div className="flex shrink-0 flex-col gap-px p-2 pt-0">
            <RailAction
              label="Settings"
              icon={Settings}
              onClick={onOpenSettings}
              shortcut={`${MOD},`}
              ariaLabel={`Settings (${MOD},)`}
            />
          </div>
        </>
      )}
      {projectMenu ? (
        <TabGroupMenu
          x={projectMenu.x}
          y={projectMenu.y}
          groupId={projectMenu.projectKey}
          label={resolveTabGroupLabel(
            projectMenu.projectKey,
            groupLabels,
            basename(projectMenu.path),
          )}
          colorIndex={resolveTabGroupColorIndex(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
          )}
          customColor={resolveTabGroupCustomColor(
            projectMenu.projectKey,
            groupCustomColors,
          )}
          currentColor={resolveTabGroupColor(
            projectMenu.projectKey,
            groupColors,
            groupCustomColors,
            projectMenu.projectKey,
          )}
          logoPath={resolveTabGroupLogo(projectMenu.projectKey, groupLogos)}
          logoProject={projectMenu.projectKey}
          mascotName={resolveTabGroupMascot(
            projectMenu.projectKey,
            groupMascots,
          )}
          mascotProject={projectMenu.projectKey}
          onRename={onProjectRename}
          onColorChange={onProjectColorChange}
          onCustomColorChange={onProjectCustomColorChange}
          onMascotChange={onProjectMascotChange}
          onLogoChange={() => {}}
          onPick={() => {}}
          onClose={() => setProjectMenu(null)}
          showActions={false}
          extraItems={projectMenuExtraItems(
            pinnedPaths.some((pinned) =>
              sameProjectPath(pinned, projectMenu.path),
            ),
            Boolean(onRemoveProject),
            groupContaining(projectGroups, projectMenu.path)?.id,
            projectGroups,
          )}
          onExtraPick={onProjectMenuPick}
        />
      ) : null}
      {groupMenu ? (
        <ExplorerMenu
          x={groupMenu.x}
          y={groupMenu.y}
          items={groupMenuItems}
          ariaLabel="Group actions"
          width={260}
          header={
            <FolderColorSwatches
              colorIndex={menuGroup?.colorIndex}
              customColor={menuGroup?.customColor}
              onChange={onGroupColorChange}
              onCustomChange={onGroupCustomColorChange}
            />
          }
          onPick={onGroupMenuPick}
          onClose={() => setGroupMenu(null)}
        />
      ) : null}
      {removing ? (
        <RemoveProjectDialog
          name={removing.name}
          path={removing.path}
          onConfirm={onConfirmDelete}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize project sidebar"
        aria-valuenow={resize.width}
        aria-valuemin={PROJECT_RAIL_WIDTH_MIN}
        aria-valuemax={PROJECT_RAIL_WIDTH_MAX}
        className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
    </nav>
  );
}

type SortableHandle = ReturnType<typeof useSortable>;
type GroupEntry = Extract<ProjectGroupEntry, { kind: "group" }>;

const LIVE_AGENT_MIN = 2;
const LIVE_AGENT_CAP = 4;

function LiveAgentsPreview({
  agents,
  activeSessionId,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agents: LiveAgent[];
  activeSessionId?: string;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lockList = useLockOverscroll<HTMLDivElement>();
  const ticking =
    agents.length >= LIVE_AGENT_MIN &&
    agents.some((agent) => !agent.done && agent.startedAt != null);

  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  if (agents.length < LIVE_AGENT_MIN) return null;

  const extra = agents.length - LIVE_AGENT_CAP;
  const visible =
    expanded || extra <= 0 ? agents : agents.slice(0, LIVE_AGENT_CAP);

  return (
    <div className="shrink-0 px-2">
      <div
        role="status"
        aria-label="Working agents"
        className="overflow-hidden rounded-lg bg-content/5"
      >
        <div className="flex items-center gap-2 px-3.5 py-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] animate-pulse"
          />
          <span className="min-w-0 flex-1 truncate text-xs text-content/50">
            Working
          </span>
          <span className="text-[11px] tabular-nums text-content/40">
            {agents.length}
          </span>
        </div>
        <div
          ref={expanded ? lockList : undefined}
          className={`flex flex-col gap-px px-1 ${
            extra > 0 ? "" : "pb-1"
          } ${expanded ? "max-h-[45vh] overflow-y-auto overscroll-none" : ""}`}
        >
          {visible.map((agent) => (
            <LiveAgentCard
              key={agent.id}
              agent={agent}
              now={now}
              selected={agent.id === activeSessionId}
              onSelect={onSelect}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupMascots={groupMascots}
            />
          ))}
        </div>
        {extra > 0 ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="flex w-full items-center justify-center gap-1 px-2 py-1.5 text-[11px] text-content/50 hover:bg-content/8 hover:text-content"
          >
            {expanded ? (
              <ChevronUp className="size-3" strokeWidth={1.75} />
            ) : (
              <ChevronDown className="size-3" strokeWidth={1.75} />
            )}
            {expanded ? "Show less" : `${extra} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LiveAgentCard({
  agent,
  now,
  selected,
  onSelect,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupMascots,
}: {
  agent: LiveAgent;
  now: number;
  selected: boolean;
  onSelect?: (sessionId: string) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupMascots: Record<string, string>;
}) {
  const projectKey = projectName(agent.cwd);
  const project = resolveTabGroupLabel(projectKey, groupLabels, projectKey);
  const color = resolveTabGroupColor(
    projectKey,
    groupColors,
    groupCustomColors,
    projectKey,
  );
  const elapsed = agent.done
    ? agent.durationMs != null
      ? formatLiveElapsed(0, agent.durationMs)
      : ""
    : agent.startedAt != null
      ? formatLiveElapsed(agent.startedAt, now)
      : "";
  const activity = agent.needsApproval
    ? "Need approval"
    : agent.done
      ? "Done"
      : agent.activity;
  const live = !agent.needsApproval && !agent.done;
  const title = [agent.title, project, activity, elapsed]
    .filter(Boolean)
    .join("\n");

  return (
    <button
      type="button"
      title={title}
      aria-label={[agent.title, project, activity, elapsed]
        .filter(Boolean)
        .join(", ")}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect?.(agent.id)}
      className={`relative flex w-full flex-col rounded-md px-2 py-1.5 text-left ${
        selected ? "bg-content/10" : "hover:bg-content/8"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ProjectMascot
          project={projectKey}
          color={color}
          name={resolveTabGroupMascot(projectKey, groupMascots)}
          className="size-2 shrink-0"
          active={live}
        />
        {live ? (
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </p>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug">
            {agent.title}
          </span>
        )}
      </span>
      <span
        className={`mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight ${
          agent.needsApproval
            ? "text-amber-400"
            : agent.done
              ? "text-emerald-400"
              : "text-content/50"
        }`}
      >
        {agent.needsApproval ? (
          <CircleAlert className="size-3 shrink-0" strokeWidth={1.75} />
        ) : agent.done ? (
          <Check className="size-3 shrink-0" strokeWidth={2.25} />
        ) : (
          <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none" />
        )}
        <span className="min-w-0 truncate">{activity}</span>
      </span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[11px] leading-tight text-content/45">
        <HarnessIcon harness={agent.harness} className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{project}</span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums">{elapsed}</span>
        ) : null}
      </span>
    </button>
  );
}

function ProjectGroupRow({
  group,
  count,
  expanded,
  pinned,
  dropTarget,
  canReorder = false,
  dropRef,
  onPointerDown,
  onToggle,
  onTogglePin,
  onContextMenu,
  onRename,
}: {
  group: ProjectGroup;
  count: number;
  expanded: boolean;
  pinned: boolean;
  dropTarget: boolean;
  canReorder?: boolean;
  dropRef?: (el: HTMLElement | null) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggle: () => void;
  onTogglePin: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onRename: () => void;
}) {
  const accent = folderAccent(group.colorIndex, group.customColor);
  return (
    <div
      ref={dropRef}
      title={group.name}
      data-tauri-drag-region="false"
      onPointerDown={onPointerDown}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className={`group relative flex touch-none items-stretch rounded-md px-2 h-8 ${
        canReorder ? "cursor-grab active:cursor-grabbing" : ""
      } ${
        dropTarget
          ? "bg-content/12 text-content"
          : "text-content/80 hover:bg-content/5 hover:text-content"
      }`}
    >
      {dropTarget ? (
        <div className="pointer-events-none absolute inset-0 rounded-md bg-accent/20" />
      ) : null}
      <button
        type="button"
        aria-expanded={expanded}
        onKeyDown={(event) => {
          if (event.key === "F2") {
            event.preventDefault();
            onRename();
          }
        }}
        className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 text-left"
      >
        <span
          className={`relative grid size-4 shrink-0 place-items-center transition-opacity group-hover:opacity-0 ${
            accent ? "" : "text-content/50"
          }`}
          style={accent ? { color: accent } : undefined}
        >
          <Folder
            className={accent ? "size-3.5" : "size-3.5 text-content"}
            strokeWidth={1.75}
          />
        </span>
        <span className="relative min-w-0 flex-1 truncate text-[13px] font-semibold leading-snug text-content">
          {group.name}
        </span>
        <span className="relative shrink-0 text-[11px] tabular-nums text-content/45">
          {count}
        </span>
      </button>
      <button
        type="button"
        data-no-drag
        title={pinned ? "Unpin group" : "Pin group"}
        aria-label={pinned ? "Unpin group" : "Pin group"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin();
        }}
        className="absolute left-2 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-content/55 opacity-0 pointer-events-none transition-opacity hover:text-content group-hover:pointer-events-auto group-hover:opacity-100"
      >
        {pinned ? (
          <PinOff className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Pin className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );
}

function ProjectGroupRenameRow({
  group,
  memberCount,
  dropTarget,
  dropRef,
  onCommit,
  onCancel,
}: {
  group: ProjectGroup;
  memberCount: number;
  dropTarget: boolean;
  dropRef?: (el: HTMLElement | null) => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const [value, setValue] = useState(group.name);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const finish = (success: boolean) => {
    if (finished.current) return;
    if (success) {
      const trimmed = value.trim();
      if (!trimmed) {
        onCancel();
        return;
      }
      finished.current = true;
      onCommit(trimmed);
      return;
    }
    finished.current = true;
    onCancel();
  };

  return (
    <div
      ref={dropRef}
      className={`relative flex w-full items-center gap-1.5 px-2 py-1.5 ${
        dropTarget ? "" : "text-content"
      }`}
    >
      {dropTarget ? (
        <div className="pointer-events-none absolute inset-0 rounded-md bg-accent/20" />
      ) : null}
      <span className="relative grid size-4 shrink-0 place-items-center text-content/50">
        <ChevronDown className="size-3.5" strokeWidth={1.75} />
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        }}
        className="relative min-w-0 flex-1 rounded bg-content/10 px-2 py-0.5 text-[13px] font-semibold leading-snug text-content outline-none ring-1 ring-accent/40"
      />
      <span className="relative shrink-0 text-[11px] tabular-nums text-content/45">
        {memberCount}
      </span>
    </div>
  );
}

function ProjectSection({
  label,
  items,
  emptyLabel,
  prepend,
  onAdd,
  cwd,
  busy,
  sortable,
  sortIndexOf,
  pinned,
  searchActive,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  label: string;
  items: RecentProject[];
  emptyLabel?: string;
  /** Blocks rendered inside the section, above the cards (group headers). */
  prepend?: ReactNode;
  onAdd?: () => void;
  cwd: string;
  busy: Set<string>;
  sortable: SortableHandle;
  sortIndexOf: (path: string) => number;
  pinned: boolean;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  return (
    <div className="shrink-0 mb-2">
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-content/50">
          {label}
        </span>
        {onAdd ? (
          <button
            type="button"
            title="Open project"
            aria-label="Open project"
            onClick={onAdd}
            className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {prepend}
      {items.length === 0 && !prepend && emptyLabel ? (
        <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">
          {emptyLabel}
        </p>
      ) : null}
      <div className="flex flex-col gap-px px-2">
        {items.map((item) => (
          <ProjectCard
            key={item.path}
            item={item}
            selected={!searchActive && sameProjectPath(item.path, cwd)}
            busy={isBusyPath(item.path, busy)}
            pinned={pinned}
            sortable={sortable}
            sortIndex={sortIndexOf(item.path)}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onContextMenu={onContextMenu}
            onOpenMenu={onOpenMenu}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupLogos={groupLogos}
            groupMascots={groupMascots}
          />
        ))}
      </div>
    </div>
  );
}

const nameClassName =
  "min-w-0 flex-1 truncate text-sm font-medium leading-tight";

function ProjectCard({
  item,
  selected,
  busy,
  pinned,
  pinnable = true,
  sortable,
  sortIndex,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  item: RecentProject;
  selected: boolean;
  busy: boolean;
  pinned: boolean;
  /** Group members pin only through their group. */
  pinnable?: boolean;
  sortable: SortableHandle;
  sortIndex: number;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  const fallbackName = basename(item.path);
  const projectKey = projectName(item.path);
  const name = resolveTabGroupLabel(projectKey, groupLabels, fallbackName);
  const logoPath = resolveTabGroupLogo(projectKey, groupLogos);
  const color = resolveTabGroupColor(
    projectKey,
    groupColors,
    groupCustomColors,
    projectKey,
  );
  const dragging = sortable.draggingId === item.path;
  const showStart =
    sortable.draggingId &&
    sortable.toIndex === sortIndex &&
    sortable.fromIndex !== null &&
    sortable.toIndex < sortable.fromIndex;
  const showEnd =
    sortable.draggingId &&
    sortable.toIndex === sortIndex &&
    sortable.fromIndex !== null &&
    sortable.toIndex > sortable.fromIndex;
  const diffEnabled = Boolean(item.path) && item.path !== "~";
  const stats = useProjectDiffStats(item.path, diffEnabled);
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const hasChanges = files > 0 || additions > 0 || deletions > 0;
  const cardTitle = projectCardTitle(item.path, name, stats, busy);
  const cardAriaLabel = projectCardAriaLabel(name, stats, busy);

  return (
    <div
      ref={(el) => sortable.setItemRef(item.path, el)}
      className={`group relative flex touch-none items-stretch rounded-md px-2 h-8 ${
        selected
          ? "bg-content/12 text-content"
          : "opacity-65 hover:bg-content/5 hover:text-content"
      } ${dragging ? "opacity-40" : ""} cursor-default`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        sortable.onItemPointerDown(item.path, event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
          return;
        }
        if (sortable.consumeClick()) return;
        onSelect(item.path);
      }}
      onContextMenu={(event) => onContextMenu(item.path, event)}
    >
      {showStart ? (
        <div className="pointer-events-none absolute inset-x-2 top-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
      {showEnd ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-0 z-20 h-0.5 rounded-full bg-accent" />
      ) : null}
      <button
        type="button"
        title={cardTitle}
        aria-label={cardAriaLabel}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left group-hover:pr-6"
      >
        <div
          className={`grid size-4 shrink-0 place-items-center ${
            pinnable ? "transition-opacity group-hover:opacity-0" : ""
          }`}
        >
          {logoPath && !busy ? (
            <ProjectLogoIcon
              path={logoPath}
              className="size-4 rounded-sm"
              imageClassName="size-4"
            />
          ) : (
            <ProjectMascot
              project={projectKey}
              color={color}
              name={resolveTabGroupMascot(projectKey, groupMascots)}
              className="size-3"
              active={busy}
            />
          )}
        </div>
        {busy ? (
          <Shimmer as="span" duration={1.4} className={nameClassName}>
            {name}
          </Shimmer>
        ) : (
          <span className={nameClassName}>{name}</span>
        )}
        {hasChanges ? (
          <span className="shrink-0 group-hover:hidden">
            <ProjectDiffStat additions={additions} deletions={deletions} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        data-no-drag
        title="Project options"
        aria-label="Project options"
        aria-haspopup="menu"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(item.path, event.clientX, event.clientY);
        }}
        className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </button>
      {pinnable ? (
        <button
          type="button"
          data-no-drag
          title={pinned ? "Unpin project" : "Pin project"}
          aria-label={pinned ? "Unpin project" : "Pin project"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(item.path);
          }}
          className="absolute left-2 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-content/55 opacity-0 pointer-events-none transition-opacity hover:text-content group-hover:pointer-events-auto group-hover:opacity-100"
        >
          {pinned ? (
            <PinOff className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Pin className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      ) : null}
    </div>
  );
}

function isBusyPath(path: string, busy: Set<string>): boolean {
  for (const other of busy) {
    if (sameProjectPath(path, other)) return true;
  }
  return false;
}

function ProjectDiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions <= 0 && deletions <= 0) return null;

  const label = [
    additions > 0 ? `+${additions}` : "",
    deletions > 0 ? `-${deletions}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      title={`${label} uncommitted`}
      className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold tabular-nums"
    >
      {additions > 0 ? (
        <span className="text-emerald-400">+{additions}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-red-400">-{deletions}</span>
      ) : null}
    </span>
  );
}

function projectCardTitle(
  path: string,
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name, path];
  if (busy) parts.push("Working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0 || additions > 0 || deletions > 0) {
    parts.push(
      [
        files > 0 ? `${files} ${files === 1 ? "file" : "files"} changed` : "",
        additions > 0 ? `+${additions}` : "",
        deletions > 0 ? `-${deletions}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.join("\n");
}

function projectCardAriaLabel(
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name];
  if (busy) parts.push("working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0) {
    parts.push(`${files} ${files === 1 ? "file" : "files"} changed`);
  }
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.join(", ");
}
