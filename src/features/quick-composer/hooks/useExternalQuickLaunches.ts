import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isHarnessAvailable,
  probeHarnessAvailability,
} from "../../../integrations/harness/core/availability";
import { IS_MAC, IS_WIN } from "../../../platform/tauri/platform";
import { modelsFor } from "../../sessions/model/models";
import { HARNESSES } from "../../sessions/model/session";
import {
  EXTERNAL_QUICK_LAUNCH_EVENT,
  externalQuickCatalog,
  externalQuickLaunch,
} from "../model/externalQuickLaunch";
import {
  initialQuickChoice,
  initialQuickProject,
  loadQuickProjects,
  rememberQuickProject,
  type QuickLaunch,
} from "../model/quickComposer";

/**
 * Linux only: an outside panel (Quickshell) talks to this window through the
 * quick socket. The window hands the socket its project and model lists
 * whenever it loses focus, since that is when the user reaches for the panel,
 * and starts the sessions the panel sends back.
 */
export function useExternalQuickLaunches(
  onLaunch: (launch: QuickLaunch, id: string) => Promise<void>,
) {
  const onLaunchRef = useRef(onLaunch);
  onLaunchRef.current = onLaunch;

  useEffect(() => {
    if (IS_MAC || IS_WIN) return;
    const publish = async () => {
      await probeHarnessAvailability().catch(() => undefined);
      const projects = loadQuickProjects();
      const catalog = externalQuickCatalog(
        projects,
        initialQuickProject(projects),
        HARNESSES.filter(isHarnessAvailable),
        modelsFor,
        initialQuickChoice(),
      );
      await invoke("quick_socket_catalog", {
        catalog: JSON.stringify(catalog),
      }).catch(() => undefined);
    };
    const stop = listen(EXTERNAL_QUICK_LAUNCH_EVENT, (event) => {
      const launch = externalQuickLaunch(
        event.payload,
        initialQuickProject(loadQuickProjects()),
        initialQuickChoice(),
      );
      if (!launch) return;
      rememberQuickProject(launch.cwd);
      void onLaunchRef
        .current(launch, crypto.randomUUID())
        .catch((error) => console.error("Quick session failed:", error))
        .finally(() => void publish());
    });
    const onBlur = () => void publish();
    void publish();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      void stop.then((unlisten) => unlisten());
    };
  }, []);
}
