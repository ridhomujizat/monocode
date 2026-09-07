import { useEffect, useRef, useState, type ComponentType } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_WIN } from "../../lib/platform";
import type { PluginHost } from "../registry";
import type { PluginManifest } from "../manifest";

/**
 * Free-form UI plugins: the manifest declares `"ui": "index.html"`, the host
 * serves the plugin's ui/ folder over `pluginui://` and renders the entry in
 * a sandboxed iframe. The frame has no access to the app — every host action
 * goes through this postMessage bridge, which binds requests and config to
 * that plugin id.
 *
 * Frame → host:  { monocode: { seq, action, ...fields } }
 * Host → frame:  { monocode: { seq, ok, result } | { seq, ok: false, error } }
 *                { monocode: { event: "init", pluginId, cwd } }  (on load)
 *
 * Actions: "request" (method,url[,headers,body]) → PluginResponse,
 * "addToChat" (title,body), "configGet" (), "configSet" (config),
 * "open" (url). Trust model is the browser-extension one: the frame runs
 * code the user chose to install; the sandbox keeps it out of the app DOM.
 */

/** The iframe URL for a plugin's UI entry file, relative to its folder. */
export function uiUrl(id: string, entry: string): string {
  const encoded = entry
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return IS_WIN
    ? `http://pluginui.localhost/${id}/${encoded}`
    : `pluginui://localhost/${id}/${encoded}`;
}

export type BridgeCall = {
  seq: unknown;
  action: string;
  fields: Record<string, unknown>;
};

/**
 * Validates an incoming postMessage as a bridge call. Returns null for
 * anything else — other windows, noise, malformed envelopes.
 */
export function parseBridgeCall(data: unknown): BridgeCall | null {
  if (typeof data !== "object" || data === null || !("monocode" in data)) {
    return null;
  }
  const envelope: unknown = data.monocode;
  if (typeof envelope !== "object" || envelope === null) return null;
  // postMessage payloads are arbitrary JSON; each field is re-validated at
  // its use site, so widening to a record here is safe.
  const source = envelope as Record<string, unknown>;
  if (!("seq" in source)) return null;
  const { seq, action } = source;
  if (typeof action !== "string") return null;
  const fields: Record<string, unknown> = {};
  for (const key of ["method", "url", "headers", "body", "config", "title"] as const) {
    if (key in source) fields[key] = source[key];
  }
  return { seq, action, fields };
}
const isStringMap = (value: unknown): value is Record<string, string> => {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
};

export function uiWorkspace(
  manifest: PluginManifest,
): ComponentType<PluginHost> {
  function UiWorkspace(host: PluginHost) {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const [failed, setFailed] = useState(false);
    const src = uiUrl(manifest.id, manifest.ui ?? "index.html");

    useEffect(() => {
      const reply = (seq: unknown, result: unknown) => {
        frameRef.current?.contentWindow?.postMessage(
          { monocode: { seq, ok: true, result } },
          "*",
        );
      };
      const fail = (seq: unknown, error: string) => {
        frameRef.current?.contentWindow?.postMessage(
          { monocode: { seq, ok: false, error } },
          "*",
        );
      };

      const handle = async (call: BridgeCall) => {
        const { seq, action, fields } = call;
        try {
          switch (action) {
            case "request": {
              if (typeof fields.method !== "string" || typeof fields.url !== "string") {
                return fail(seq, "request needs string method and url");
              }
              const headers = isStringMap(fields.headers)
                ? Object.entries(fields.headers)
                : undefined;
              const response = await host.request({
                method: fields.method,
                url: fields.url,
                ...(headers ? { headers } : {}),
                ...(typeof fields.body === "string" ? { body: fields.body } : {}),
              });
              reply(seq, response);
              return;
            }
            case "addToChat": {
              if (typeof fields.title !== "string" || typeof fields.body !== "string") {
                return fail(seq, "addToChat needs string title and body");
              }
              host.addToChat(fields.title, fields.body);
              reply(seq, null);
              return;
            }
            case "configGet": {
              reply(seq, await host.loadConfig<unknown>());
              return;
            }
            case "configSet": {
              if (typeof fields.config !== "object" || fields.config === null) {
                return fail(seq, "configSet needs a config object");
              }
              await host.saveConfig(fields.config);
              reply(seq, null);
              return;
            }
            case "open": {
              if (
                typeof fields.url !== "string" ||
                !(fields.url.startsWith("https://") || fields.url.startsWith("http://"))
              ) {
                return fail(seq, "open needs an http(s) url");
              }
              await openUrl(fields.url);
              reply(seq, null);
              return;
            }
            default:
              fail(seq, `unknown action ${JSON.stringify(action)}`);
          }
        } catch (cause) {
          fail(seq, String(cause));
        }
      };

      const onMessage = (event: MessageEvent) => {
        const frame = frameRef.current;
        if (!frame || event.source !== frame.contentWindow) return;
        const call = parseBridgeCall(event.data);
        if (call) void handle(call);
      };

      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [host]);

    if (failed) {
      return (
        <p className="flex flex-1 items-center justify-center p-4 text-[12px] text-content/50">
          UI files for “{manifest.label}” are missing on disk. Reinstall the
          plugin.
        </p>
      );
    }

    return (
      <iframe
        ref={frameRef}
        title={manifest.label}
        src={src}
        onLoad={() => {
          frameRef.current?.contentWindow?.postMessage(
            { monocode: { event: "init", pluginId: manifest.id, cwd: host.cwd } },
            "*",
          );
        }}
        onError={() => setFailed(true)}
        sandbox="allow-scripts allow-forms allow-modals"
        className="min-h-0 w-full flex-1 border-0 bg-transparent"
      />
    );
  }

  return UiWorkspace;
}
