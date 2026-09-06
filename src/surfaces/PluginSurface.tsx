import { useMemo } from "react";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { IS_MAC } from "../lib/platform";
import { pluginHost, type Plugin } from "../plugins/registry";

type Props = {
  plugin: Plugin;
  cwd: string;
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

/** Overlay chrome around a plugin workspace, same shape as Notes. */
export function PluginSurface({
  plugin,
  cwd,
  besideRail = false,
  onClose,
  onToggleSidebar,
}: Props) {
  const host = useMemo(() => pluginHost(plugin, cwd), [plugin, cwd]);
  const Icon = plugin.icon;
  const Workspace = plugin.Workspace;
  // The rail only opens plugins that have one; a card-only plugin has not.
  if (!Workspace) return null;

  return (
    <div
      role="region"
      aria-label={plugin.label}
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-content/10"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Icon
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">{plugin.label}</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Workspace {...host} />
      </div>
    </div>
  );
}
