import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore, type ComponentType } from "react";
import * as iconSet from "../chrome/icons";
import type { IconComponent } from "../chrome/icons";
import { ADD_NOTE_TO_CHAT_EVENT, type NoteComposerCard } from "../lib/notes";
import { manifestWorkspace } from "./ManifestWorkspace";
import { validateManifest, type PluginManifest } from "./manifest";
import { syncPluginProcesses } from "./process";
import { uiWorkspace } from "./ui/UiWorkspace";

/**
 * Every plugin is external: a `plugin.json` manifest in
 * `<appData>/plugins/<id>/`, installed at runtime. A manifest with `request`
 * gets a workspace rendered by `ManifestWorkspace`; one with `ui` renders its
 * own interface in a sandboxed frame (`./ui/UiWorkspace.tsx`); one with
 * `startup`/`actions` runs argv commands and pushes a rail card instead (see
 * `./process.ts`). Any combination. Reference: `docs/plugins-for-ai.md`.
 */
export type Plugin = {
  /** Rail id and config folder name. Lowercase letters, digits and dashes. */
  id: string;
  label: string;
  icon: IconComponent;
  /** Absent for a plugin that only contributes a card and actions. */
  Workspace?: ComponentType<PluginHost>;
};

/** Everything the host hands a workspace. Plugins import nothing else. */
export type PluginHost = {
  /** Active project, for plugins that scope themselves per repo. */
  cwd: string;
  /** Send a result to the composer as a note-shaped chip on a new session. */
  addToChat: (title: string, body: string) => void;
  /** HTTP via Rust — the webview CSP allows `connect-src ipc:` only. */
  request: (request: PluginRequest) => Promise<PluginResponse>;
  /** Whole-config read/write, one 0600 JSON file per plugin. Tokens go here. */
  loadConfig: <T>() => Promise<T | null>;
  saveConfig: (config: unknown) => Promise<void>;
};

export type PluginRequest = {
  method: string;
  url: string;
  headers?: [string, string][];
  body?: string;
};

export type PluginResponse = {
  status: number;
  headers: [string, string][];
  body: string;
  ms: number;
};

/** A row in Settings › Plugins. `plugin` is absent when the manifest is bad. */
export type InstalledPlugin = {
  id: string;
  label: string;
  enabled: boolean;
  description?: string;
  plugin?: Plugin;
  /** The parsed manifest, for user plugins that passed validation. */
  manifest?: PluginManifest;
  error?: string;
};

type ManifestRow = { id: string; manifest: unknown; error?: string };

const DISABLED_KEY = "monocode.plugins.disabled";
const disabled = loadDisabled();

let userPlugins: InstalledPlugin[] = [];
let loaded = false;
let enabledSnapshot: Plugin[] = [];
let installedSnapshot: InstalledPlugin[] = [];
const listeners = new Set<() => void>();

recompute();

/** Enabled plugins, for the rail and the open workspace. */
export function usePlugins(): Plugin[] {
  return useSyncExternalStore(
    subscribePlugins,
    () => enabledSnapshot,
    () => enabledSnapshot,
  );
}

/** Everything installed, enabled or not, for Settings. */
export function useInstalledPlugins(): InstalledPlugin[] {
  return useSyncExternalStore(
    subscribePlugins,
    () => installedSnapshot,
    () => installedSnapshot,
  );
}

export async function refreshPlugins(): Promise<void> {
  const rows = await invoke<ManifestRow[]>("plugins_list");
  userPlugins = rows.map(manifestEntry);
  loaded = true;
  emit();
}

/** Writes `<appData>/plugins/<id>/plugin.json`. Also the update path. */
export async function installPlugin(value: unknown): Promise<string> {
  const check = validateManifest(value);
  if ("error" in check) throw new Error(check.error);
  const id = await invoke<string>("plugin_install", {
    manifest: check.manifest,
  });
  await refreshPlugins();
  return id;
}

/** Removes the manifest, the config and the stored token. */
export async function uninstallPlugin(id: string): Promise<void> {
  await invoke("plugin_uninstall", { id });
  if (disabled.delete(id)) saveDisabled();
  await refreshPlugins();
}

export function setPluginEnabled(id: string, enabled: boolean) {
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  saveDisabled();
  emit();
}

export function pluginsDir(): Promise<string> {
  return invoke<string>("plugins_dir");
}

export function loadPluginConfig(id: string): Promise<unknown> {
  return invoke<unknown>("plugin_config_get", { id });
}

export function savePluginConfig(id: string, config: unknown): Promise<void> {
  return invoke<void>("plugin_config_set", { id, config });
}

export function pluginHost(plugin: Plugin, cwd: string): PluginHost {
  return {
    cwd,
    addToChat: (title, body) => {
      if (!body.trim()) return;
      const card: NoteComposerCard = {
        id: `${plugin.id}-${Date.now().toString(36)}`,
        slug: plugin.id,
        title: title.trim() || plugin.label,
        body,
        ...(cwd ? { sourceCwd: cwd } : {}),
      };
      window.dispatchEvent(
        new CustomEvent<NoteComposerCard>(ADD_NOTE_TO_CHAT_EVENT, {
          detail: card,
        }),
      );
    },
    request: (request) =>
      invoke<PluginResponse>("plugin_fetch", {
        request: { headers: [], ...request },
      }),
    loadConfig: <T>() => loadPluginConfig(plugin.id) as Promise<T | null>,
    saveConfig: (config) => savePluginConfig(plugin.id, config),
  };
}

/** Icon by export name from `src/chrome/icons.tsx`, `Wrench` when unknown. */
export function iconByName(name?: string): IconComponent {
  const found =
    name && /^[A-Z]/.test(name)
      ? (iconSet as Record<string, unknown>)[name]
      : undefined;
  return typeof found === "function"
    ? (found as IconComponent)
    : iconSet.Wrench;
}

let focusBound = false;

/**
 * Filesystem installs (copy a folder, drop a manifest) land outside the
 * app's knowledge, and the list is otherwise scanned once per page load.
 * Re-scan whenever the window regains focus so a new plugin shows up the
 * next time the user looks at the rail — no manual Refresh needed.
 */
function bindFocusRefresh() {
  if (focusBound) return;
  focusBound = true;
  window.addEventListener("focus", () => {
    void refreshPlugins().catch(() => {});
  });
}

function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener);
  if (!loaded) {
    loaded = true;
    bindFocusRefresh();
    void refreshPlugins().catch(() => {});
  }
  return () => listeners.delete(listener);
}

function manifestEntry(row: ManifestRow): InstalledPlugin {
  const broken = (error: string): InstalledPlugin => ({
    id: row.id,
    label: row.id,
    enabled: false,
    error,
  });
  if (row.error) return broken(row.error);
  const check = validateManifest(row.manifest);
  if ("error" in check) return broken(check.error);
  const manifest = check.manifest;
  if (manifest.id !== row.id) {
    return broken(`"id" must match the folder name ("${row.id}")`);
  }
  return {
    id: row.id,
    label: manifest.label,
    enabled: true,
    ...(manifest.description ? { description: manifest.description } : {}),
    manifest,
    plugin: manifestPlugin(manifest),
  };
}

function manifestPlugin(manifest: PluginManifest): Plugin {
  return {
    id: manifest.id,
    label: manifest.label,
    icon: iconByName(manifest.icon),
    // A free-form ui replaces the generated list workspace; no `request` and
    // no `ui` means nothing to show full-screen — a rail card plugin only.
    ...(manifest.ui
      ? { Workspace: uiWorkspace(manifest) }
      : manifest.request
        ? { Workspace: manifestWorkspace(manifest) }
        : {}),
  };
}

function recompute() {
  installedSnapshot = userPlugins
    .map((entry) => ({
      ...entry,
      enabled: !entry.error && !disabled.has(entry.id),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  syncPluginProcesses(
    installedSnapshot.flatMap((entry) =>
      entry.enabled && entry.manifest ? [entry.manifest] : [],
    ),
  );
}

function emit() {
  recompute();
  for (const listener of listeners) listener();
}

function loadDisabled(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? "[]");
    return new Set(
      Array.isArray(raw)
        ? raw.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function saveDisabled() {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...disabled]));
  } catch {
    // private mode / quota
  }
}
