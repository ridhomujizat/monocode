import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle,
  ChevronDown,
  CircleDashed,
  CircleX,
  Clock,
  Eye,
} from "../../../shared/ui/icons";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";
import { CollapsibleBody } from "./InboxComments";
import type { InboxItem } from "../model/githubTasks";
import {
  KERJAN_STATUS_LABELS,
  kerjanConnected,
  kerjanNextStatuses,
  kerjanTicketDetails,
  listKerjanMembers,
  moveKerjanTask,
  setKerjanAssignee,
  type KerjanMember,
  type KerjanTicket,
} from "../model/kerjan";

const CHIP =
  "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md border border-content/10 bg-content/5 px-2 text-[12px] text-content/80 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40";
const OPTION =
  "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] text-content/80 hover:bg-content/10 hover:text-content";

/** Status and assignee actions for a Kerjan ticket in the detail pane. */
export function KerjanTicketActions({
  item,
  revision,
}: {
  item: InboxItem;
  revision: number;
}) {
  const key = item.identifier ?? "";
  const [ticket, setTicket] = useState<KerjanTicket | null>(null);
  const [members, setMembers] = useState<KerjanMember[]>([]);
  const [memberId, setMemberId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([
      kerjanTicketDetails(key, { force: true }),
      listKerjanMembers(),
      kerjanConnected(),
    ])
      .then(([details, nextMembers, status]) => {
        if (cancelled) return;
        setTicket(details.ticket);
        setMembers(nextMembers);
        setMemberId(status.memberId);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [key, revision]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setTicket((await kerjanTicketDetails(key)).ticket);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!ticket) {
    return error ? (
      <span className="text-[12px] text-red-400/90">{error}</span>
    ) : null;
  }

  const task = ticket.kind === "task";
  const nextStatuses = task ? kerjanNextStatuses(ticket.status) : [];
  const assignee = members.find((member) => member.id === ticket.assignee_id);

  return (
    <>
      {task ? (
        <Menu
          label={KERJAN_STATUS_LABELS[ticket.status] ?? ticket.status}
          disabled={busy || nextStatuses.length === 0}
          title={
            nextStatuses.length === 0
              ? "This status cannot change from here"
              : "Change status"
          }
        >
          {(close) =>
            nextStatuses.map((status) => (
              <button
                key={status}
                type="button"
                className={OPTION}
                onClick={() => {
                  close();
                  void run(() => moveKerjanTask(item, status));
                }}
              >
                Move to {KERJAN_STATUS_LABELS[status]}
              </button>
            ))
          }
        </Menu>
      ) : null}
      {task ? (
        <AssigneeMenu
          label={assignee?.name ?? "Unassigned"}
          disabled={
            busy || ticket.status === "done" || ticket.status === "canceled"
          }
          members={members}
          memberId={memberId}
          canUnassign={ticket.assignee_id != null && ticket.status === "todo"}
          onPick={(id) => void run(() => setKerjanAssignee(item, id))}
        />
      ) : null}
      {error ? (
        <span className="basis-full text-[12px] text-red-400/90">{error}</span>
      ) : null}
    </>
  );
}

const STATUS_MARKS: Record<
  string,
  { Icon: typeof CircleDashed; className: string }
> = {
  todo: { Icon: CircleDashed, className: "text-content/50" },
  in_progress: { Icon: Clock, className: "text-amber-400/90" },
  ready_for_qa: { Icon: Eye, className: "text-sky-400/90" },
  done: { Icon: CheckCircle, className: "text-emerald-400/90" },
  canceled: { Icon: CircleX, className: "text-rose-400/90" },
};

export function kerjanStatusMark(status: string) {
  return STATUS_MARKS[status] ?? STATUS_MARKS.todo!;
}

/**
 * For a Task, its parent Story and that Story's Tasks; for a Story, its own
 * Tasks. Clicking a Task opens it in the detail pane.
 */
export function KerjanStoryContext({
  item,
  revision,
  cwd,
  onAddToChat,
  onOpenTask,
}: {
  item: InboxItem;
  revision: number;
  cwd: string;
  onAddToChat?: (body: string) => void;
  onOpenTask?: (task: KerjanTicket, members: readonly KerjanMember[]) => void;
}) {
  const key = item.identifier ?? "";
  const [ticket, setTicket] = useState<KerjanTicket | null>(null);
  const [story, setStory] = useState<KerjanTicket | null>(null);
  const [members, setMembers] = useState<KerjanMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([
      kerjanTicketDetails(key, { force: true }),
      listKerjanMembers().catch(() => []),
    ])
      .then(async ([{ ticket: next }, nextMembers]) => {
        const parent =
          next.kind === "story"
            ? next
            : next.story_key
              ? (await kerjanTicketDetails(next.story_key, { force: true }))
                  .ticket
              : null;
        if (cancelled) return;
        setTicket(next);
        setStory(parent);
        setMembers(nextMembers);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [key, revision]);

  if (error) {
    return <p className="text-[12px] text-red-400/90">{error}</p>;
  }
  if (!ticket || !story) return null;
  const ownStory = ticket.kind === "story";
  const description = story.description?.trim() ?? "";
  const tasks = story.tasks ?? [];

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-stroke px-3 py-2.5">
      {ownStory ? null : (
        <>
          <header className="flex min-w-0 items-center gap-2 text-[12px] text-content/50">
            <span className="shrink-0 text-content/70">Parent story</span>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate">
              {story.key} {story.title}
            </span>
            <span className="shrink-0">
              · {KERJAN_STATUS_LABELS[story.status] ?? story.status}
            </span>
            {onAddToChat ? (
              <button
                type="button"
                onClick={() => onAddToChat(kerjanStoryChatBody(story))}
                className="ml-auto shrink-0 hover:text-content"
              >
                Add to chat
              </button>
            ) : null}
          </header>
          {description ? (
            <CollapsibleBody>
              <AgentMarkdown
                className="inbox-comment-md"
                text={description}
                cwd={cwd}
                allowRemoteMedia
              />
            </CollapsibleBody>
          ) : (
            <p className="text-[12px] text-content/45">No description</p>
          )}
        </>
      )}
      {tasks.length > 0 ? (
        <div className={ownStory ? "" : "border-t border-stroke pt-2"}>
          <p className="mb-1 text-[12px] text-content/70">
            Tasks{" "}
            <span className="text-content/45">
              {tasks.filter((task) => task.status === "done").length}/
              {tasks.length} done
            </span>
          </p>
          <ul className="flex flex-col">
            {tasks.map((task) => (
              <li key={task.key}>
                <KerjanTaskRow
                  task={task}
                  current={task.key === ticket.key}
                  assignee={
                    members.find((member) => member.id === task.assignee_id)
                      ?.name ?? ""
                  }
                  onOpen={
                    onOpenTask ? () => onOpenTask(task, members) : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function KerjanTaskRow({
  task,
  current,
  assignee,
  onOpen,
}: {
  task: KerjanTicket;
  current: boolean;
  assignee: string;
  onOpen?: () => void;
}) {
  const mark = kerjanStatusMark(task.status);
  const label = KERJAN_STATUS_LABELS[task.status] ?? task.status;
  return (
    <button
      type="button"
      disabled={current || !onOpen}
      onClick={onOpen}
      title={`${label} · ${task.key} ${task.title}`}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] ${
        current
          ? "bg-content/5 text-content"
          : "text-content/75 hover:bg-content/5 hover:text-content"
      }`}
    >
      <mark.Icon
        className={`size-3 shrink-0 ${mark.className}`}
        strokeWidth={1.75}
      />
      <span className="shrink-0 tabular-nums text-content/45">{task.key}</span>
      <span
        className={`min-w-0 flex-1 truncate ${
          task.status === "canceled" ? "line-through text-content/45" : ""
        }`}
      >
        {task.title}
      </span>
      {assignee ? (
        <span className="max-w-28 shrink-0 truncate text-content/45">
          {assignee}
        </span>
      ) : null}
    </button>
  );
}

export function kerjanStoryChatBody(story: KerjanTicket): string {
  const description = story.description?.trim();
  return [
    `Story ${story.key} ${story.title}`.trim(),
    description ? `\n${description}` : "",
  ].join("\n");
}

function AssigneeMenu({
  label,
  disabled,
  members,
  memberId,
  canUnassign,
  onPick,
}: {
  label: string;
  disabled: boolean;
  members: readonly KerjanMember[];
  memberId: number;
  canUnassign: boolean;
  onPick: (id: number | null) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return members
      .filter((member) => member.active && member.id !== memberId)
      .filter((member) => !needle || member.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [members, memberId, query]);

  return (
    <Menu label={label} disabled={disabled} title="Change assignee">
      {(close) => {
        const pick = (id: number | null) => {
          close();
          setQuery("");
          onPick(id);
        };
        return (
          <>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search members"
              className="mb-1 h-7 w-full rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content outline-none placeholder:text-content/40"
            />
            {memberId ? (
              <button
                type="button"
                className={OPTION}
                onClick={() => pick(memberId)}
              >
                Assign to me
              </button>
            ) : null}
            {canUnassign ? (
              <button
                type="button"
                className={OPTION}
                onClick={() => pick(null)}
              >
                Unassign
              </button>
            ) : null}
            {visible.map((member) => (
              <button
                key={member.id}
                type="button"
                className={OPTION}
                onClick={() => pick(member.id)}
              >
                <span className="min-w-0 truncate">{member.name}</span>
                {member.kind === "agent" ? (
                  <span className="ml-auto pl-2 text-content/40">agent</span>
                ) : null}
              </button>
            ))}
          </>
        );
      }}
    </Menu>
  );
}

function Menu({
  label,
  title,
  disabled,
  children,
}: {
  label: string;
  title: string;
  disabled: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (button.current?.contains(target) || menu.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        className={CHIP}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          className="size-3 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <div
          ref={menu}
          className="absolute left-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-content/10 bg-content/10 p-1 shadow-xl backdrop-blur-xl"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
