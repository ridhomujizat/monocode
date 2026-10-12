import { useEffect, useState } from "react";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { clearInboxCache } from "../../inbox/model/githubTasks";
import {
  disconnectKerjan,
  kerjanConnected,
  notifyKerjanChange,
  saveKerjanConfig,
  type KerjanStatus,
} from "../../inbox/model/kerjan";

export function KerjanSettings() {
  const [status, setStatus] = useState<KerjanStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://kerjan.omni-x.dev");
  const [workspaceId, setWorkspaceId] = useState("");
  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void kerjanConnected()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = baseUrl.trim() && workspaceId.trim() && token.trim();

  const connect = async () => {
    if (busy || checking || !ready) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await saveKerjanConfig({ baseUrl, token, workspaceId }));
      setToken("");
      clearInboxCache();
      notifyKerjanChange();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await disconnectKerjan());
      setToken("");
      clearInboxCache();
      notifyKerjanChange();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3.5">
      {checking ? (
        <p className="text-[12px] text-content/45">
          Checking Kerjan connection…
        </p>
      ) : status?.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-[12px] text-content/65">
            <p className="break-all">{status.baseUrl}</p>
            <p>
              {status.memberName || `Member ${status.memberId}`} · workspace{" "}
              {status.workspaceId}
            </p>
          </div>
          <SecondaryButton onClick={() => void disconnect()} disabled={busy}>
            {busy ? "Disconnecting" : "Disconnect"}
          </SecondaryButton>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-[12px] leading-relaxed text-content/45">
            Connect with an agent token (kjt_…) from Member → Agent tokens, and
            the ID of the Workspace the agent belongs to. Disconnect deletes the
            saved token.
          </p>
          {(
            [
              {
                label: "Kerjan URL",
                value: baseUrl,
                set: setBaseUrl,
                type: "text",
                placeholder: "https://kerjan.omni-x.dev",
              },
              {
                label: "Workspace ID",
                value: workspaceId,
                set: setWorkspaceId,
                type: "text",
                placeholder: "1",
              },
              {
                label: "Agent token",
                value: token,
                set: setToken,
                type: "password",
                placeholder: "kjt_…",
              },
            ] as const
          ).map((field) => (
            <label
              key={field.label}
              className="flex flex-col gap-1 text-[12px] text-content/65"
            >
              {field.label}
              <input
                aria-label={field.label}
                type={field.type}
                value={field.value}
                onChange={(event) => field.set(event.target.value)}
                placeholder={field.placeholder}
                disabled={busy}
                required
                autoComplete="off"
                spellCheck={false}
                className="h-8 w-full rounded-md border border-content/10 bg-transparent px-2 text-content outline-none focus:border-content/20"
              />
            </label>
          ))}
          <div>
            <SecondaryButton type="submit" disabled={busy || !ready}>
              {busy ? "Connecting" : "Connect"}
            </SecondaryButton>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-[12px] text-red-400/90">
          {error}
        </p>
      ) : null}
    </div>
  );
}
