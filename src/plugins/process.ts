/**
 * Process plugins: the manifest declares argv commands, the host spawns them in
 * the plugin folder, and each line they write to stdout is a UI push.
 *
 * Push, not poll — a watcher stays alive and repaints whenever it has news
 * (`startup`), and rows carry the id of a declared `action` to run when
 * clicked. Modelled on luvus modules, which proved the shape.
 *
 *   {"method":"card","params":{"rows":[{"text":"▶ Song","action":"playpause"}]}}
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { PluginManifest } from "./manifest";

export type CardDot = "working" | "blocked" | "done" | "idle";

export type CardRow = {
  text: string;
  dot?: CardDot;
  /** Declared action id to run on click. */
  action?: string;
  /** Opaque payload handed to that action as `MONOCODE_ROW_VALUE`. */
  value?: string;
};

export type PluginCard = { pluginId: string; title: string; rows: CardRow[] };

type LineEvent = {
  pluginId: string;
  label: string;
  line: string;
  stderr: boolean;
};
type ExitEvent = { pluginId: string; label: string; code: number | null };

const DOTS: CardDot[] = ["working", "blocked", "done", "idle"];
const LOG_LIMIT = 50;
const ROWS_MAX = 200;

/**
 * One stdout line → a push, a complaint, or nothing (plain output, which the
 * log keeps). Kept pure: this is the part worth testing.
 */
export function decodePush(
  line: string,
  actionIds: string[],
):
  | { method: "card"; rows: CardRow[] }
  | { error: string }
  | { log: string }
  | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return trimmed ? { log: trimmed } : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { log: trimmed };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { log: trimmed };
  }
  const { method, params } = parsed as { method?: unknown; params?: unknown };
  if (method !== "card") {
    return { error: `unknown method ${JSON.stringify(method ?? null)}` };
  }
  const raw = (params as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(raw)) return { error: '"card" needs params.rows[]' };
  const rows: CardRow[] = [];
  for (const entry of raw.slice(0, ROWS_MAX)) {
    if (!entry || typeof entry !== "object") {
      return { error: "every card row must be an object" };
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.text !== "string") {
      return { error: 'every card row needs "text"' };
    }
    if (row.action !== undefined) {
      if (typeof row.action !== "string" || !actionIds.includes(row.action)) {
        return { error: `no action "${String(row.action)}" in the manifest` };
      }
    }
    if (row.dot !== undefined && !DOTS.includes(row.dot as CardDot)) {
      return { error: `"dot" must be one of ${DOTS.join(", ")}` };
    }
    rows.push({
      text: row.text,
      ...(row.dot ? { dot: row.dot as CardDot } : {}),
      ...(row.action ? { action: row.action } : {}),
      ...(typeof row.value === "string" ? { value: row.value } : {}),
    });
  }
  return { method: "card", rows };
}

const manifests = new Map<string, PluginManifest>();
const cards = new Map<string, PluginCard>();
const logs = new Map<string, string[]>();
const listeners = new Set<() => void>();
let cardSnapshot: PluginCard[] = [];
let projectCwd = "";
let bridged = false;

/** Cards plugins have pushed, for the project rail. */
export function usePluginCards(): PluginCard[] {
  return useSyncExternalStore(
    subscribeCards,
    () => cardSnapshot,
    () => cardSnapshot,
  );
}

const NO_LINES: string[] = [];

/** Last lines a plugin wrote, newest last. Shown in Settings › Plugins. */
export function usePluginLog(id: string): string[] {
  return useSyncExternalStore(
    subscribeCards,
    () => logs.get(id) ?? NO_LINES,
    () => NO_LINES,
  );
}

/** The project a command should act on, injected as `MONOCODE_PROJECT_CWD`. */
export function setPluginProjectCwd(cwd: string) {
  projectCwd = cwd;
}

/**
 * Starts the `startup` commands of plugins that are newly enabled and stops
 * every process of plugins that are no longer in the list.
 */
export function syncPluginProcesses(enabled: PluginManifest[]) {
  bridge();
  const wanted = new Set(enabled.map((manifest) => manifest.id));
  for (const id of [...manifests.keys()]) {
    if (wanted.has(id)) continue;
    manifests.delete(id);
    cards.delete(id);
    void invoke("plugin_stop", { id }).catch(() => {});
    emit();
  }
  for (const manifest of enabled) {
    if (manifests.has(manifest.id)) continue;
    manifests.set(manifest.id, manifest);
    if (manifest.card) {
      cards.set(manifest.id, {
        pluginId: manifest.id,
        title: manifest.card.title,
        rows: [],
      });
      emit();
    }
    for (const entry of manifest.startup ?? []) {
      void run(manifest, "startup", entry.command);
    }
  }
}

export function stopAllPluginProcesses(): Promise<void> {
  return invoke<void>("plugin_stop_all").catch(() => undefined);
}

/** Runs a declared action, e.g. because a card row was clicked. */
export function runPluginAction(id: string, actionId: string, value?: string) {
  const manifest = manifests.get(id);
  const action = manifest?.actions?.find((entry) => entry.id === actionId);
  if (!manifest || !action) return;
  void run(manifest, `action:${actionId}`, action.command, value);
}

async function run(
  manifest: PluginManifest,
  label: string,
  argv: string[],
  value?: string,
) {
  const env: [string, string][] = [["MONOCODE_PROJECT_CWD", projectCwd]];
  if (value !== undefined) env.push(["MONOCODE_ROW_VALUE", value]);
  const config = await invoke<Record<string, unknown> | null>(
    "plugin_config_get",
    { id: manifest.id },
  ).catch(() => null);
  for (const [key, raw] of Object.entries(config ?? {})) {
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    env.push([`MONOCODE_SETTING_${key.toUpperCase()}`, String(raw)]);
  }
  try {
    await invoke("plugin_run", {
      id: manifest.id,
      label,
      argv,
      env,
    });
  } catch (cause) {
    log(manifest.id, `${label}: ${String(cause)}`);
  }
}

function bridge() {
  if (bridged) return;
  bridged = true;
  void listen<LineEvent>("plugin_line", ({ payload }) => {
    const manifest = manifests.get(payload.pluginId);
    if (!manifest) return;
    if (payload.stderr) {
      log(payload.pluginId, `${payload.label}: ${payload.line}`);
      return;
    }
    const push = decodePush(
      payload.line,
      (manifest.actions ?? []).map((action) => action.id),
    );
    if (!push) return;
    if ("log" in push) {
      log(payload.pluginId, `${payload.label}: ${push.log}`);
      return;
    }
    if ("error" in push) {
      log(payload.pluginId, `${payload.label}: ${push.error}`);
      return;
    }
    const card = cards.get(payload.pluginId);
    if (!card) {
      log(payload.pluginId, `${payload.label}: pushed rows without a "card"`);
      return;
    }
    cards.set(payload.pluginId, { ...card, rows: push.rows });
    emit();
  });
  void listen<ExitEvent>("plugin_exit", ({ payload }) => {
    if (payload.code === 0 || payload.code === null) return;
    log(payload.pluginId, `${payload.label}: exited with ${payload.code}`);
  });
}

function log(id: string, line: string) {
  const lines = logs.get(id) ?? [];
  lines.push(line);
  logs.set(id, lines.slice(-LOG_LIMIT));
  emit();
}

function subscribeCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  cardSnapshot = [...cards.values()];
  for (const listener of listeners) listener();
}
