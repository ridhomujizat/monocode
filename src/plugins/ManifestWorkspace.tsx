import { useCallback, useEffect, useState, type ComponentType } from "react";
import { LoaderCircle, RefreshCw, Settings } from "../chrome/icons";
import {
  itemBody,
  itemTitle,
  itemsOf,
  missingFields,
  render,
  requestHeaders,
  type PluginManifest,
} from "./manifest";
import type { PluginHost } from "./registry";

type Config = Record<string, string>;

/** Renders any manifest plugin: connect form, then a list (or one response). */
export function manifestWorkspace(
  manifest: PluginManifest,
): ComponentType<PluginHost> {
  function ManifestWorkspace({
    addToChat,
    request,
    loadConfig,
    saveConfig,
  }: PluginHost) {
    const [config, setConfig] = useState<Config | null>(null);
    const [draft, setDraft] = useState<Config>({});
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [items, setItems] = useState<unknown[] | null>(null);
    const [raw, setRaw] = useState<string>("");

    const run = useCallback(
      async (values: Config) => {
        const spec = manifest.request;
        if (!spec) return;
        setBusy(true);
        setError(null);
        try {
          const response = await request({
            method: spec.method ?? "GET",
            url: render(spec.url, values),
            headers: requestHeaders(manifest, values),
            ...(spec.body ? { body: render(spec.body, values) } : {}),
          });
          setRaw(response.body);
          if (response.status >= 400) {
            setItems(null);
            setError(`Request failed with ${response.status}`);
            return;
          }
          if (manifest.items === undefined) {
            setItems(null);
            return;
          }
          setItems(itemsOf(safeJson(response.body), manifest.items));
        } catch (cause) {
          setItems(null);
          setError(String(cause));
        } finally {
          setBusy(false);
        }
      },
      [request],
    );

    useEffect(() => {
      void loadConfig<Config>().then((saved) => {
        const values = saved ?? {};
        setConfig(values);
        setDraft(values);
        if (missingFields(manifest, values).length > 0) {
          setEditing(true);
          return;
        }
        void run(values);
      });
    }, [loadConfig, run]);

    const save = async () => {
      const values: Config = {};
      for (const field of manifest.fields ?? []) {
        values[field.key] = draft[field.key]?.trim() ?? "";
      }
      await saveConfig(values);
      setConfig(values);
      setEditing(false);
      if (missingFields(manifest, values).length === 0) void run(values);
    };

    if (config === null) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <LoaderCircle
            className="size-4 animate-spin text-content/40"
            strokeWidth={1.75}
          />
        </div>
      );
    }

    if (editing) {
      return (
        <div className="mx-auto flex w-full max-w-lg flex-col gap-3 p-6">
          {manifest.description ? (
            <p className="text-[13px] leading-relaxed text-content/50">
              {manifest.description}
            </p>
          ) : null}
          {(manifest.fields ?? []).map((field) => (
            <label key={field.key} className="flex flex-col gap-1">
              <span className="text-[12px] text-content/60">
                {field.label ?? field.key}
              </span>
              <input
                value={draft[field.key] ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, [field.key]: event.target.value })
                }
                placeholder={field.placeholder}
                type={field.secret ? "password" : "text"}
                spellCheck={false}
                className="h-8 rounded-md border border-content/10 bg-content/6 px-2 text-[13px] outline-none"
              />
            </label>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-white"
            >
              Save
            </button>
            {missingFields(manifest, config).length === 0 ? (
              <button
                type="button"
                onClick={() => {
                  setDraft(config);
                  setEditing(false);
                }}
                className="h-8 rounded-md border border-content/10 px-3 text-[13px] hover:bg-content/10"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-content/10 px-3 py-2 text-[12px] text-content/50">
          <button
            type="button"
            onClick={() => void run(config)}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-content/10 hover:text-content disabled:opacity-40"
          >
            {busy ? (
              <LoaderCircle
                className="size-3.5 animate-spin"
                strokeWidth={1.75}
              />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.75} />
            )}
            Refresh
          </button>
          {items ? <span>{items.length} items</span> : null}
          {(manifest.fields ?? []).length > 0 ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-content/10 hover:text-content"
            >
              <Settings className="size-3.5" strokeWidth={1.75} />
              Connection
            </button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error ? (
            <p className="rounded-md border border-content/10 bg-content/6 p-2 text-[12px] text-content/70">
              {error}
            </p>
          ) : null}

          {items ? (
            <div className="flex flex-col gap-1">
              {items.map((item, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() =>
                    addToChat(
                      itemTitle(manifest, item),
                      itemBody(manifest, item),
                    )
                  }
                  title="Add to chat"
                  className="flex flex-col items-start gap-0.5 rounded-md border border-content/10 px-3 py-2 text-left hover:bg-content/10"
                >
                  <span className="w-full truncate text-[13px] font-medium text-content">
                    {itemTitle(manifest, item)}
                  </span>
                  {manifest.item?.subtitle ? (
                    <span className="w-full truncate text-[12px] text-content/45">
                      {render(manifest.item.subtitle, item)}
                    </span>
                  ) : null}
                </button>
              ))}
              {items.length === 0 && !error && !busy ? (
                <p className="p-2 text-[12px] text-content/45">Nothing here.</p>
              ) : null}
            </div>
          ) : raw ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => addToChat(manifest.label, raw)}
                className="self-start rounded-md border border-content/10 px-2 py-1 text-[12px] hover:bg-content/10"
              >
                Add to chat
              </button>
              <pre className="overflow-auto rounded-md border border-content/10 bg-content/6 p-2 font-mono text-[12px] leading-snug">
                {pretty(raw)}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return ManifestWorkspace;
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
