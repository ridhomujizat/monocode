import { convertFileSrc } from "@tauri-apps/api/core";
import {
  runPluginAction,
  usePluginCards,
  type CardDot,
  type CardRow,
  type PluginCard,
} from "../plugins/process";
import { iconByName } from "../plugins/registry";

const DOT_CLASS: Record<CardDot, string> = {
  working: "bg-accent",
  blocked: "bg-red-400",
  done: "bg-emerald-400",
  idle: "bg-content/30",
};

/**
 * Cards process plugins push into the rail. The host owns the rendering — a
 * plugin only sends rows, and a row naming a declared `action` is a button.
 */
export function PluginCards() {
  const cards = usePluginCards();
  if (cards.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-2 px-2 pb-2">
      {cards.map((card) => (
        <Card key={card.pluginId} card={card} />
      ))}
    </div>
  );
}

function Card({ card }: { card: PluginCard }) {
  if (card.rows.length === 0) return null;

  return (
    <div className="rounded-md border border-content/10 bg-content/5 p-1.5">
      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-content/40">
        {card.title}
      </div>
      {chunkRows(card.rows).map((chunk, index) =>
        chunk.kind === "group" ? (
          <ControlGroup
            key={`g-${index}`}
            pluginId={card.pluginId}
            rows={chunk.rows}
          />
        ) : (
          <Row key={`r-${index}`} pluginId={card.pluginId} row={chunk.row} />
        ),
      )}
    </div>
  );
}

type Chunk =
  | { kind: "row"; row: CardRow }
  | { kind: "group"; rows: CardRow[] };

/** Consecutive rows that share a `group` id render as one horizontal strip. */
function chunkRows(rows: CardRow[]): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const group = row.group;
    if (group) {
      const block: CardRow[] = [];
      while (i < rows.length && rows[i].group === group) {
        block.push(rows[i]);
        i += 1;
      }
      out.push({ kind: "group", rows: block });
      continue;
    }
    out.push({ kind: "row", row });
    i += 1;
  }
  return out;
}

function ControlGroup({
  pluginId,
  rows,
}: {
  pluginId: string;
  rows: CardRow[];
}) {
  return (
    <div className="mt-0.5 flex items-center justify-between gap-0.5 px-0.5 py-0.5">
      {rows.map((row, index) => {
        const Icon = row.icon ? iconByName(row.icon) : null;
        return (
          <button
            key={`${row.action ?? row.text}-${index}`}
            type="button"
            title={row.text}
            aria-label={row.text}
            disabled={!row.action}
            onClick={() =>
              row.action &&
              runPluginAction(pluginId, row.action, row.value)
            }
            className="flex h-7 min-w-0 flex-1 items-center justify-center rounded text-content/55 hover:bg-content/10 hover:text-content disabled:opacity-40"
          >
            {Icon ? <Icon size={14} /> : (
              <span className="truncate px-0.5 text-[10px]">{row.text}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Row({ pluginId, row }: { pluginId: string; row: CardRow }) {
  if (row.image || row.subtext !== undefined || row.progress !== undefined) {
    return <MediaRow pluginId={pluginId} row={row} />;
  }

  const Icon = row.icon ? iconByName(row.icon) : null;
  const body = (
    <>
      {row.dot ? (
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[row.dot]}`}
        />
      ) : null}
      {Icon ? <Icon size={12} className="shrink-0 opacity-70" /> : null}
      <span className="min-w-0 truncate">{row.text}</span>
    </>
  );

  if (!row.action) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5 font-mono text-[11px] leading-tight tracking-tight text-content/45">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => runPluginAction(pluginId, row.action ?? "", row.value)}
      className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] text-content/70 hover:bg-content/10 hover:text-content"
    >
      {body}
    </button>
  );
}

function MediaRow({ pluginId, row }: { pluginId: string; row: CardRow }) {
  const src = row.image
    ? `${convertFileSrc(row.image)}?v=${encodeURIComponent(row.imageKey ?? row.text)}`
    : null;
  const ratio =
    typeof row.progress === "number" && Number.isFinite(row.progress)
      ? Math.min(1, Math.max(0, row.progress))
      : null;

  const body = (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-start gap-2">
        {src ? (
          <img
            src={src}
            alt=""
            className="size-11 shrink-0 rounded object-cover shadow-sm ring-1 ring-content/10"
            draggable={false}
          />
        ) : (
          <div className="flex size-11 shrink-0 items-center justify-center rounded bg-content/10 text-content/30 ring-1 ring-content/10">
            {(() => {
              const Note = iconByName("Play");
              return <Note size={16} />;
            })()}
          </div>
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1.5">
            {row.dot ? (
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[row.dot]}`}
              />
            ) : null}
            <span className="min-w-0 truncate text-[12px] font-medium leading-snug text-content">
              {row.text}
            </span>
          </div>
          {row.subtext ? (
            <div className="mt-0.5 truncate text-[11px] leading-snug text-content/45">
              {row.subtext}
            </div>
          ) : null}
        </div>
      </div>
      {ratio !== null || row.clock ? (
        <div className="flex min-w-0 items-center gap-2 px-0.5">
          {ratio !== null ? (
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-content/10">
              <div
                className="h-full rounded-full bg-accent/80 transition-[width] duration-200 ease-out"
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
          ) : null}
          {row.clock ? (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-content/40">
              {row.clock}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (!row.action) {
    return <div className="px-1 py-1">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => runPluginAction(pluginId, row.action ?? "", row.value)}
      className="w-full rounded px-1 py-1 text-left hover:bg-content/10"
    >
      {body}
    </button>
  );
}
