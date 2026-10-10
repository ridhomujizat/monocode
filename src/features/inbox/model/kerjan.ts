import { invoke } from "@tauri-apps/api/core";
import { recordInboxSelfActivity } from "./inboxSelfActivity";

export type KerjanStatus = {
  connected: boolean;
  baseUrl: string;
  workspaceId: string;
  memberId: number;
  memberName: string;
};

export type KerjanTicketStatus =
  "todo" | "in_progress" | "ready_for_qa" | "done" | "canceled";

/** Raw ticket as returned by the Kerjan MCP server. */
export type KerjanTicket = {
  id: number;
  key: string;
  workspace_id: number;
  kind: "epic" | "story" | "task";
  title: string;
  description?: string;
  status: KerjanTicketStatus | string;
  task_type?: string;
  qa_key?: string;
  severity?: string;
  story_key?: string;
  story_title?: string;
  sprint_id?: number | null;
  assignee_id: number | null;
  estimate?: number;
  created_by?: number;
  created_at: string;
  done_at?: string | null;
  canceled_at?: string | null;
  tasks?: KerjanTicket[];
};

export type KerjanMember = {
  id: number;
  name: string;
  kind: string;
  active: boolean;
};

type KerjanSprint = {
  id: number;
  name: string;
  state: string;
};

type KerjanComment = {
  id: number;
  author_id: number;
  body: string;
  created_at: string;
};

type KerjanTicketResponse = {
  ticket: KerjanTicket;
  story?: KerjanTicket | null;
  comments?: KerjanComment[] | null;
};

export type KerjanIssue = {
  provider: "kerjan";
  kind: "kerjan";
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  state: string;
  stateType: string;
  updatedAt: string;
  labels: { name: string; color: string }[];
  assignees: { login: string; avatarUrl?: string }[];
  draft: boolean;
  repo: string;
  teamId: string;
  teamName: string;
  /** Sprint the ticket belongs to. Empty in the Backlog. */
  projectId: string;
  projectName: string;
  projectPath: string;
};

export type KerjanTicketDetails = {
  body: string;
  author: string;
  ticket: KerjanTicket;
  story: KerjanTicket | null;
};

export type KerjanTicketComment = {
  id: string;
  kind: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  path: string;
  line: number | null;
  resolved: boolean;
  threadId: string;
  replies: KerjanTicketComment[];
};

export type KerjanTicketThread = {
  comments: KerjanTicketComment[];
  truncated: boolean;
  reviewDecision: string;
  baseRefName: string;
  headRefName: string;
};

export const KERJAN_CHANGE_EVENT = "monocode:kerjan-change";

export const KERJAN_STATUS_LABELS: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  ready_for_qa: "Ready for QA",
  done: "Done",
  canceled: "Canceled",
};

const KIND_COLORS: Record<string, string> = {
  dev: "#3b82f6",
  qa: "#a855f7",
  bug: "#ef4444",
  story: "#10b981",
  epic: "#f59e0b",
};

let membersPromise: Promise<KerjanMember[]> | null = null;
const responseByKey = new Map<string, KerjanTicketResponse>();
const responseInflight = new Map<string, Promise<KerjanTicketResponse>>();

function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("kerjan_call", { tool, arguments: args });
}

export function kerjanConnected(): Promise<KerjanStatus> {
  return invoke<KerjanStatus>("kerjan_status");
}

export async function saveKerjanConfig(config: {
  baseUrl: string;
  token: string;
  workspaceId: string;
}): Promise<KerjanStatus> {
  const status = await invoke<KerjanStatus>("kerjan_set_config", {
    baseUrl: config.baseUrl.trim(),
    token: config.token.trim(),
    workspaceId: config.workspaceId.trim(),
  });
  clearKerjanCache();
  return status;
}

export async function disconnectKerjan(): Promise<KerjanStatus> {
  const status = await invoke<KerjanStatus>("kerjan_set_config", {
    baseUrl: "",
    token: "",
    workspaceId: "",
  });
  clearKerjanCache();
  return status;
}

export function clearKerjanCache() {
  membersPromise = null;
  responseByKey.clear();
  responseInflight.clear();
}

export function listKerjanMembers(): Promise<KerjanMember[]> {
  membersPromise ??= call<KerjanMember[]>("list_members").catch((error) => {
    membersPromise = null;
    throw error;
  });
  return membersPromise;
}

/**
 * "Assigned to me" lists the member's Tasks. Otherwise the inbox shows the
 * Stories of every active Sprint, which is what the team is working on now.
 */
export async function listKerjanIssues(query: {
  assignedToMe: boolean;
  memberId: number;
}): Promise<KerjanIssue[]> {
  const [members, sprints] = await Promise.all([
    listKerjanMembers(),
    call<KerjanSprint[]>("list_sprints"),
  ]);
  const tickets = query.assignedToMe
    ? await call<KerjanTicket[]>("list_tickets", {
        assignee_id: query.memberId,
      })
    : await activeSprintTickets(sprints);
  const names = memberNames(members);
  const sprintNames = new Map(
    sprints.map((sprint) => [sprint.id, sprint.name]),
  );
  // Every status comes back; the inbox status filter hides what it should.
  return tickets.map((ticket) =>
    kerjanTicketToIssue(ticket, names, sprintNames),
  );
}

async function activeSprintTickets(
  sprints: readonly KerjanSprint[],
): Promise<KerjanTicket[]> {
  const lists = await Promise.all(
    sprints
      .filter((sprint) => sprint.state === "active")
      .map((sprint) =>
        call<KerjanTicket[]>("list_tickets", { sprint_id: sprint.id }),
      ),
  );
  return lists.flat();
}

export function kerjanTicketToIssue(
  ticket: KerjanTicket,
  names: ReadonlyMap<number, string>,
  sprintNames: ReadonlyMap<number, string>,
): KerjanIssue {
  const type =
    ticket.kind === "task" ? ticket.task_type || "task" : ticket.kind;
  const labels = [{ name: type, color: KIND_COLORS[type] ?? "" }];
  if (ticket.severity) labels.push({ name: ticket.severity, color: "" });
  const assignee =
    ticket.assignee_id != null ? names.get(ticket.assignee_id) : undefined;
  const sprint =
    ticket.sprint_id != null ? sprintNames.get(ticket.sprint_id) : undefined;
  const parent = ticket.story_key
    ? `${ticket.story_key} ${ticket.story_title ?? ""}`.trim()
    : "";
  return {
    provider: "kerjan",
    kind: "kerjan",
    id: String(ticket.id),
    identifier: ticket.key,
    number: kerjanKeyNumber(ticket.key),
    title: ticket.title,
    url: "",
    state: KERJAN_STATUS_LABELS[ticket.status] ?? ticket.status,
    stateType: ticket.status,
    updatedAt: ticket.done_at || ticket.canceled_at || ticket.created_at,
    labels,
    assignees: assignee ? [{ login: assignee }] : [],
    draft: false,
    repo: ticket.key.split("-")[0] ?? "",
    teamId: ticket.sprint_id != null ? String(ticket.sprint_id) : "",
    teamName: parent || sprint || "",
    projectId: ticket.sprint_id != null ? String(ticket.sprint_id) : "",
    projectName: sprint ?? "",
    projectPath: "",
  };
}

export function kerjanKeyNumber(key: string): number {
  const match = /-(\d+)$/.exec(key.trim());
  return match ? Number(match[1]) : 0;
}

function memberNames(members: readonly KerjanMember[]): Map<number, string> {
  return new Map(members.map((member) => [member.id, member.name]));
}

function fetchTicket(
  key: string,
  options?: { force?: boolean },
): Promise<KerjanTicketResponse> {
  // A request already in flight is as fresh as a forced one, so the detail
  // pane, its thread and its actions share one get_ticket per refresh.
  const pending = responseInflight.get(key);
  if (pending) return pending;
  const cached = options?.force ? undefined : responseByKey.get(key);
  if (cached) return Promise.resolve(cached);
  const promise = call<KerjanTicketResponse>("get_ticket", { key })
    .then((response) => {
      responseByKey.set(key, response);
      return response;
    })
    .finally(() => {
      if (responseInflight.get(key) === promise) responseInflight.delete(key);
    });
  responseInflight.set(key, promise);
  return promise;
}

function toDetails(
  response: KerjanTicketResponse,
  names: ReadonlyMap<number, string>,
): KerjanTicketDetails {
  const { ticket } = response;
  return {
    body: ticket.description ?? "",
    author:
      ticket.created_by != null ? (names.get(ticket.created_by) ?? "") : "",
    ticket,
    story: response.story ?? null,
  };
}

export function peekKerjanTicketDetails(
  key: string,
): KerjanTicketDetails | null {
  const response = responseByKey.get(key);
  return response ? toDetails(response, new Map()) : null;
}

export async function kerjanTicketDetails(
  key: string,
  options?: { force?: boolean },
): Promise<KerjanTicketDetails> {
  const [response, members] = await Promise.all([
    fetchTicket(key, options),
    listKerjanMembers().catch(() => []),
  ]);
  return toDetails(response, memberNames(members));
}

export async function kerjanTicketThread(
  key: string,
  options?: { force?: boolean },
): Promise<KerjanTicketThread> {
  const [response, members] = await Promise.all([
    fetchTicket(key, options),
    listKerjanMembers().catch(() => []),
  ]);
  return kerjanThread(response.comments ?? [], memberNames(members));
}

export function peekKerjanTicketThread(key: string): KerjanTicketThread | null {
  const response = responseByKey.get(key);
  return response ? kerjanThread(response.comments ?? [], new Map()) : null;
}

export function kerjanThread(
  comments: readonly KerjanComment[],
  names: ReadonlyMap<number, string>,
): KerjanTicketThread {
  return {
    comments: comments.map((comment) => ({
      id: String(comment.id),
      kind: "comment",
      author: names.get(comment.author_id) ?? `Member ${comment.author_id}`,
      body: comment.body,
      createdAt: comment.created_at,
      url: "",
      state: "",
      path: "",
      line: null,
      resolved: false,
      threadId: "",
      replies: [],
    })),
    truncated: false,
    reviewDecision: "",
    baseRefName: "",
    headRefName: "",
  };
}

function afterWrite(key: string, id?: string) {
  responseByKey.delete(key);
  responseInflight.delete(key);
  recordInboxSelfActivity({ provider: "kerjan", kind: "kerjan", id });
  notifyKerjanChange();
}

export async function kerjanTicketComment(
  item: { id?: string; identifier?: string },
  body: string,
): Promise<string> {
  const key = requireKey(item.identifier);
  await call("add_comment", { key, body: body.trim() });
  afterWrite(key, item.id);
  return "";
}

/** Task status transitions Kerjan accepts from the given status. */
export function kerjanNextStatuses(status: string): KerjanTicketStatus[] {
  if (status === "todo") return ["in_progress"];
  if (status === "in_progress") return ["todo", "done"];
  return [];
}

export async function moveKerjanTask(
  item: { id?: string; identifier?: string },
  status: KerjanTicketStatus,
): Promise<void> {
  const key = requireKey(item.identifier);
  await call("move_task", { key, status });
  afterWrite(key, item.id);
}

export async function setKerjanAssignee(
  item: { id?: string; identifier?: string },
  assigneeId: number | null,
): Promise<void> {
  const key = requireKey(item.identifier);
  await call("set_assignee", { key, assignee_id: assigneeId });
  afterWrite(key, item.id);
}

function requireKey(key: string | undefined): string {
  const trimmed = key?.trim();
  if (!trimmed) throw new Error("Missing Kerjan ticket");
  return trimmed;
}

export function notifyKerjanChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(KERJAN_CHANGE_EVENT));
}
