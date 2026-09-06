import {
  runPluginAction,
  usePluginCards,
  type CardDot,
  type CardRow,
  type PluginCard,
} from "../plugins/process";

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
      {card.rows.map((row, index) => (
        <Row key={index} pluginId={card.pluginId} row={row} />
      ))}
    </div>
  );
}

function Row({ pluginId, row }: { pluginId: string; row: CardRow }) {
  const body = (
    <>
      {row.dot ? (
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS[row.dot]}`}
        />
      ) : null}
      <span className="min-w-0 truncate">{row.text}</span>
    </>
  );

  if (!row.action) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5 text-[12px] text-content/55">
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
