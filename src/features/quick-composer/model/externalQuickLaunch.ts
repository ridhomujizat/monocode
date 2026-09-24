import { projectName } from "../../../shared/lib/paths";
import type { AgentModel } from "../../sessions/model/models";
import {
  HARNESS_TITLE,
  type HarnessId,
} from "../../sessions/model/session";
import {
  isHarnessId,
  parseQuickLaunch,
  type QuickChoice,
  type QuickLaunch,
} from "./quickComposer";

/** Event the Linux quick socket (src-tauri/src/quick_socket.rs) emits. */
export const EXTERNAL_QUICK_LAUNCH_EVENT = "external_quick_launch";

/** What an outside panel can offer: the same lists the macOS panel shows. */
export type ExternalQuickCatalog = {
  projects: { path: string; name: string }[];
  project: string | null;
  harnesses: {
    id: HarnessId;
    title: string;
    models: { id: string; name: string }[];
  }[];
  choice: QuickChoice;
};

export function externalQuickCatalog(
  projects: string[],
  project: string | null,
  harnesses: HarnessId[],
  modelsFor: (harness: HarnessId) => AgentModel[],
  choice: QuickChoice,
): ExternalQuickCatalog {
  return {
    projects: projects.map((path) => ({ path, name: projectName(path) })),
    project,
    harnesses: harnesses.map((id) => ({
      id,
      title: HARNESS_TITLE[id],
      models: modelsFor(id).map((model) => ({
        id: model.id,
        name: model.provider
          ? `${model.name} · ${model.provider.name}`
          : model.name,
      })),
    })),
    choice,
  };
}

/**
 * The panel may name a project and a harness/model; whatever it leaves out
 * falls back to what the macOS panel would have picked: the project the last
 * quick session used and the Providers default.
 */
export function externalQuickLaunch(
  raw: unknown,
  project: string | null,
  choice: QuickChoice,
): QuickLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const request = raw as Record<string, unknown>;
  const cwd =
    typeof request.cwd === "string" && request.cwd.trim()
      ? request.cwd
      : project;
  const picked = isHarnessId(request.harness)
    ? {
        harness: request.harness,
        model: typeof request.model === "string" ? request.model : undefined,
      }
    : choice;
  return parseQuickLaunch({
    prompt: request.prompt,
    cwd,
    harness: picked.harness,
    model: picked.model,
    reveal: request.reveal === true,
  });
}
