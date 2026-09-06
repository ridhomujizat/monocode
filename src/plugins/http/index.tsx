import { useEffect, useState } from "react";
import { Zap } from "../../chrome/icons";
import type { Plugin, PluginHost, PluginResponse } from "../registry";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

type Saved = {
  method?: string;
  url?: string;
  headers?: string;
  body?: string;
};

/** `Name: value` per line, `#` comments and blanks skipped. */
export function parseHeaders(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf(":");
    if (at <= 0) continue;
    const name = trimmed.slice(0, at).trim();
    if (name) out.push([name, trimmed.slice(at + 1).trim()]);
  }
  return out;
}

export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function HttpWorkspace({
  addToChat,
  request,
  loadConfig,
  saveConfig,
}: PluginHost) {
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<PluginResponse | null>(null);

  useEffect(() => {
    void loadConfig<Saved>().then((saved) => {
      if (!saved) return;
      setMethod(saved.method ?? "GET");
      setUrl(saved.url ?? "");
      setHeaders(saved.headers ?? "");
      setBody(saved.body ?? "");
    });
  }, [loadConfig]);

  const send = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    void saveConfig({ method, url, headers, body });
    try {
      setResponse(
        await request({
          method,
          url,
          headers: parseHeaders(headers),
          ...(method === "GET" ? {} : { body }),
        }),
      );
    } catch (cause) {
      setResponse(null);
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <select
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          className="h-8 rounded-md border border-content/10 bg-content/6 px-2 text-[13px]"
        >
          {METHODS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          placeholder="https://api.example.com/v1/issues"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-md border border-content/10 bg-content/6 px-2 text-[13px] outline-none"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !url.trim()}
          className="h-8 rounded-md bg-accent px-3 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Headers">
          <textarea
            value={headers}
            onChange={(event) => setHeaders(event.target.value)}
            placeholder={
              "Authorization: Bearer …\nContent-Type: application/json"
            }
            spellCheck={false}
            className="h-24 w-full resize-y rounded-md border border-content/10 bg-content/6 p-2 font-mono text-[12px] outline-none"
          />
        </Field>
        <Field label="Body">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder='{ "hello": "world" }'
            spellCheck={false}
            className="h-24 w-full resize-y rounded-md border border-content/10 bg-content/6 p-2 font-mono text-[12px] outline-none"
          />
        </Field>
      </div>

      {error ? (
        <p className="rounded-md border border-content/10 bg-content/6 p-2 text-[12px] text-content/70">
          {error}
        </p>
      ) : null}

      {response ? (
        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center gap-3 text-[12px] text-content/50">
            <span className="font-semibold text-content">
              {response.status}
            </span>
            <span>{response.ms} ms</span>
            <span>{response.body.length} bytes</span>
            <button
              type="button"
              onClick={() =>
                addToChat(
                  `${method} ${url}`,
                  [
                    `${method} ${url} → ${response.status} (${response.ms} ms)`,
                    "",
                    "```",
                    prettyBody(response.body).slice(0, 20_000),
                    "```",
                  ].join("\n"),
                )
              }
              className="ml-auto rounded-md border border-content/10 px-2 py-1 text-[12px] hover:bg-content/10"
            >
              Add to chat
            </button>
          </div>
          <pre className="min-h-0 overflow-auto rounded-md border border-content/10 bg-content/6 p-2 font-mono text-[12px] leading-snug">
            {prettyBody(response.body)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-content/45">
        {label}
      </span>
      {children}
    </label>
  );
}

const plugin: Plugin = {
  id: "http",
  label: "HTTP",
  icon: Zap,
  Workspace: HttpWorkspace,
};

export default plugin;
