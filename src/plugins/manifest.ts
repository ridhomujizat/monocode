/**
 * User-authored plugin format: JSON, no code. The webview CSP rules out
 * loading third-party script at runtime, so a manifest declares *what* to
 * fetch and *how* to label the result, and `ManifestWorkspace` renders it.
 *
 * Lives at `<appData>/plugins/<id>/plugin.json`. See docs/plugins-for-ai.md.
 */

export type PluginField = {
  /** Config key, and the name to use in `{{templates}}`. */
  key: string;
  label?: string;
  placeholder?: string;
  /** Masked input; still stored in the plugin's 0600 config file. */
  secret?: boolean;
};

export type PluginAuth =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; user: string; password: string };

/** One argv command. Runs in the plugin folder, in any language. */
export type PluginCommand = { command: string[] };

/** A command the UI can invoke: from a card row, or from a menu entry. */
export type PluginAction = {
  id: string;
  title: string;
  command: string[];
};

export type PluginManifest = {
  id: string;
  label: string;
  /** Name of an export from src/chrome/icons.tsx, e.g. "Zap". */
  icon?: string;
  description?: string;
  /** Values the user fills in once; available to every template. */
  fields?: PluginField[];
  auth?: PluginAuth;
  /** Omit for a plugin that only runs commands. */
  request?: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  };
  /** A card this plugin owns on the project rail. Content is pushed, not polled. */
  card?: { title: string };
  /** Run once when the plugin loads — usually a watcher that keeps pushing. */
  startup?: PluginCommand[];
  /** Invoked by card rows (`action`) and by nothing else, for now. */
  actions?: PluginAction[];
  /** Dotted path to the array in the response. Omit for a single-result view. */
  items?: string;
  item?: {
    title: string;
    subtitle?: string;
    /** Defaults to the item as pretty JSON. */
    body?: string;
  };
};

const ID_RE = /^[a-z0-9-]{1,40}$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/**
 * Shape check with messages meant for whoever wrote the file. Path safety and
 * the URL scheme are enforced again in Rust — this is for feedback, not trust.
 */
export function validateManifest(
  value: unknown,
): { manifest: PluginManifest } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Manifest must be a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
    return { error: '"id" must be 1-40 chars of a-z, 0-9 or -' };
  }
  if (typeof raw.label !== "string" || !raw.label.trim()) {
    return { error: '"label" is required' };
  }
  for (const key of ["icon", "description"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      return { error: `"${key}" must be a string` };
    }
  }

  const request = raw.request;
  const hasRequest = request !== undefined;
  if (
    hasRequest &&
    (!request || typeof request !== "object" || Array.isArray(request))
  ) {
    return { error: '"request" must be an object' };
  }
  const req = (request ?? {}) as Record<string, unknown>;
  if (hasRequest && (typeof req.url !== "string" || !req.url.trim())) {
    return { error: '"request.url" is required' };
  }
  if (req.method !== undefined) {
    if (
      typeof req.method !== "string" ||
      !METHODS.includes(req.method.toUpperCase())
    ) {
      return { error: `"request.method" must be one of ${METHODS.join(", ")}` };
    }
  }
  if (req.headers !== undefined) {
    if (!isStringMap(req.headers)) {
      return { error: '"request.headers" must be a map of string to string' };
    }
  }
  if (req.body !== undefined && typeof req.body !== "string") {
    return { error: '"request.body" must be a string' };
  }

  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) return { error: '"fields" must be a list' };
    for (const field of raw.fields) {
      if (!field || typeof field !== "object") {
        return { error: 'each "fields" entry must be an object' };
      }
      const entry = field as Record<string, unknown>;
      if (typeof entry.key !== "string" || !entry.key.trim()) {
        return { error: 'each "fields" entry needs a "key"' };
      }
      if (entry.secret !== undefined && typeof entry.secret !== "boolean") {
        return { error: `"fields.${entry.key}.secret" must be true or false` };
      }
    }
  }

  if (raw.auth !== undefined) {
    const auth = raw.auth as Record<string, unknown> | null;
    const bearer =
      auth?.kind === "bearer" && typeof auth.token === "string" && auth.token;
    const basic =
      auth?.kind === "basic" &&
      typeof auth.user === "string" &&
      typeof auth.password === "string";
    if (!bearer && !basic) {
      return {
        error:
          '"auth" must be { kind: "bearer", token } or { kind: "basic", user, password }',
      };
    }
  }

  if (raw.items !== undefined && typeof raw.items !== "string") {
    return { error: '"items" must be a dotted path string' };
  }
  if (raw.items !== undefined) {
    const item = raw.item as Record<string, unknown> | undefined;
    if (!item || typeof item.title !== "string" || !item.title.trim()) {
      return { error: '"item.title" is required when "items" is set' };
    }
    for (const key of ["subtitle", "body"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") {
        return { error: `"item.${key}" must be a string` };
      }
    }
  }

  if (raw.card !== undefined) {
    const card = raw.card as Record<string, unknown> | null;
    if (!card || typeof card.title !== "string" || !card.title.trim()) {
      return { error: '"card.title" is required' };
    }
  }

  for (const key of ["startup", "actions"] as const) {
    if (raw[key] === undefined) continue;
    if (!Array.isArray(raw[key])) return { error: `"${key}" must be a list` };
  }
  for (const entry of (raw.startup as unknown[]) ?? []) {
    const error = argvError(entry, "startup");
    if (error) return { error };
  }
  const ids = new Set<string>();
  for (const entry of (raw.actions as unknown[]) ?? []) {
    const error = argvError(entry, "actions");
    if (error) return { error };
    const action = entry as Record<string, unknown>;
    if (typeof action.id !== "string" || !ID_RE.test(action.id)) {
      return { error: 'each "actions" entry needs an "id" of a-z, 0-9 or -' };
    }
    if (typeof action.title !== "string" || !action.title.trim()) {
      return { error: `"actions.${action.id}" needs a "title"` };
    }
    if (ids.has(action.id)) {
      return { error: `duplicate action id "${action.id}"` };
    }
    ids.add(action.id);
  }

  if (!hasRequest && !raw.actions && !raw.startup) {
    return {
      error:
        'a plugin needs either "request" (fetch) or "startup"/"actions" (commands)',
    };
  }
  if (raw.card !== undefined && !raw.startup) {
    return { error: '"card" needs a "startup" command to push its rows' };
  }

  return { manifest: raw as unknown as PluginManifest };
}

/** Shared shape check for anything carrying `command = [...]`. */
function argvError(entry: unknown, where: string): string | null {
  if (!entry || typeof entry !== "object") {
    return `each "${where}" entry must be an object`;
  }
  const argv = (entry as Record<string, unknown>).command;
  if (!Array.isArray(argv) || argv.length === 0) {
    return `each "${where}" entry needs a non-empty "command" list`;
  }
  if (argv.some((part) => typeof part !== "string" || !part.length)) {
    return `"${where}" command entries must be non-empty strings`;
  }
  return null;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * `a.b.0.c` lookup. Returns undefined rather than throwing on a bad path.
 * `.` and `$` mean the value itself, for lists of plain strings.
 */
export function pick(source: unknown, path: string): unknown {
  if (!path || path === "." || path === "$") return source;
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * `{{dotted.path}}` substitution. Missing values render empty, objects render
 * as JSON. No escaping — an author writing a query string escapes it.
 */
export function render(template: string, scope: unknown): string {
  return template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, path: string) => {
    const value = pick(scope, path);
    if (value == null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/** The list the workspace renders, or [] when the path misses. */
export function itemsOf(
  response: unknown,
  path: string | undefined,
): unknown[] {
  const value = pick(response, path ?? "");
  return Array.isArray(value) ? value : [];
}

/** Config keys the user still has to fill in before the plugin can run. */
export function missingFields(
  manifest: PluginManifest,
  config: Record<string, string> | null,
): PluginField[] {
  return (manifest.fields ?? []).filter(
    (field) => !config?.[field.key]?.trim(),
  );
}

/** Manifest + config → the headers `plugin_fetch` should send. */
export function requestHeaders(
  manifest: PluginManifest,
  config: Record<string, string>,
): [string, string][] {
  const headers = Object.entries(manifest.request?.headers ?? {}).map(
    ([name, value]) => [name, render(value, config)] as [string, string],
  );
  const auth = manifest.auth;
  if (auth?.kind === "bearer") {
    headers.push(["Authorization", `Bearer ${render(auth.token, config)}`]);
  } else if (auth?.kind === "basic") {
    const user = render(auth.user, config);
    const password = render(auth.password, config);
    headers.push(["Authorization", `Basic ${btoa(`${user}:${password}`)}`]);
  }
  return headers;
}

export function itemTitle(manifest: PluginManifest, item: unknown): string {
  const title = render(manifest.item?.title ?? "", item).trim();
  // Every placeholder missing leaves the separators behind ("A · B" -> "·"),
  // which reads as a broken row rather than an empty one.
  return /[\p{L}\p{N}]/u.test(title) ? title : "Untitled";
}

export function itemBody(manifest: PluginManifest, item: unknown): string {
  const template = manifest.item?.body;
  return template ? render(template, item) : JSON.stringify(item, null, 2);
}
