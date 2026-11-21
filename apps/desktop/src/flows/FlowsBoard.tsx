import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { FlowCard } from "../platform/commands";
import { prLabel, relativeTime, absoluteTime } from "../lib/format";
import { Icon } from "../components/Icon";
import { EmptyState, Kbd, Spinner } from "../components/ui";
import { FlowDetailSheet, type LinkedSession } from "./FlowDetail";
import { LANES, STATUS_LABEL, byUpdatedDesc, laneOf, matches, type LaneId } from "./model";
import type { useFlows } from "./useFlows";

type Flows = ReturnType<typeof useFlows>;

interface Props {
  cwd: string;
  initialOpenDir?: string | null;
  onOpenIssue?: (dir: string) => void;
  flows: Flows;
  /** Sessions already linked to a flow package, newest first. */
  linkedSessions: (dir: string) => LinkedSession[];
  /** Work on a flow in a new session or in one already linked to it. */
  onOpenSession: (card: FlowCard) => void;
  onWorkOn: (card: FlowCard, target: "new" | string) => void;
}

const LANE_CAP = 30;
const DONE_CAP = 20;
const LIST_CAP = 150;

export function FlowsBoard({ cwd, initialOpenDir = null, flows, onOpenIssue, linkedSessions, onWorkOn, onOpenSession }: Props) {
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<string>("");
  const [view, setView] = useState<"board" | "list">(() => {
    try {
      return localStorage.getItem("keryx.flows.view") === "list" ? "list" : "board";
    } catch {
      return "board";
    }
  });
  const [openDir, setOpenDir] = useState<string | null>(initialOpenDir);
  const search = useRef<HTMLInputElement>(null);
  const q = useDeferredValue(query);

  useEffect(() => {
    try {
      localStorage.setItem("keryx.flows.view", view);
    } catch {
      /* per-viewer convenience only */
    }
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const owners = useMemo(() => {
    const set = new Set<string>();
    for (const c of flows.cards) if (c.owner) set.add(c.owner);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [flows.cards]);

  const visible = useMemo(
    () => flows.cards.filter((c) => matches(c, q) && (!owner || c.owner === owner)).sort(byUpdatedDesc),
    [flows.cards, q, owner],
  );

  const lanes = useMemo(() => {
    const map = new Map<LaneId, FlowCard[]>();
    for (const c of visible) {
      const lane = laneOf(c);
      const list = map.get(lane) ?? [];
      list.push(c);
      map.set(lane, list);
    }
    return map;
  }, [visible]);

  const broken = useMemo(() => visible.filter((c) => c.error), [visible]);
  const openCard = openDir ? flows.cards.find((c) => c.dir === openDir) ?? null : null;
  const activeCount = visible.filter((c) => laneOf(c) !== "done").length;

  return (
    <div className="flows">
      <div className="flows-toolbar">
        <div className="flows-heading">
          <h1 className="sr-only">Flows</h1>
          <span className="count-label">
            {activeCount} active · {visible.length - activeCount} done
          </span>
        </div>
        <div className="search-field">
          <Icon name="search" size={14} />
          <input
            ref={search}
            type="search"
            placeholder="Search by title or #id"
            aria-label="Search flows"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          <Kbd>⌘F</Kbd>
        </div>
        <select className="select-compact" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner">
          <option value="">All owners</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <div className="grow" />
        <div className="segmented" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={view === "board"} onClick={() => setView("board")} title="Board">
            <Icon name="board" size={14} /> Board
          </button>
          <button role="radio" aria-checked={view === "list"} onClick={() => setView("list")} title="List">
            <Icon name="list" size={14} /> List
          </button>
        </div>
        <button
          className="icon-btn"
          onClick={() => void flows.refresh()}
          aria-label="Refresh flows"
          title={flows.refreshedAt ? `Refreshed ${relativeTime(new Date(flows.refreshedAt).toISOString())}` : "Refresh"}
        >
          {flows.loading ? <Spinner /> : <Icon name="refresh" size={15} />}
        </button>
      </div>

      {flows.error ? (
        <div className="inline-banner tone-danger">
          <Icon name="alert" size={14} />
          <span>Could not read flows: {flows.error}</span>
          <button className="btn btn-sm" onClick={() => void flows.refresh()}>
            Try again
          </button>
        </div>
      ) : null}

      {broken.length > 0 ? (
        <div className="inline-banner tone-warn">
          <Icon name="alert" size={14} />
          <span>
            {broken.length} flow{broken.length > 1 ? "s" : ""} could not be read. They are shown with a{" "}
            <strong>Unreadable</strong> badge.
          </span>
        </div>
      ) : null}

      {flows.empty && !flows.loading && !flows.error ? (
        <EmptyState icon="board" title="No flows in this project">
          <p>
            Flows live in <code>.metaproject/flows/</code>. Start one from a terminal with <code>keryx flow init</code>, or ask
            keryx in a session to plan a piece of work as a flow.
          </p>
        </EmptyState>
      ) : visible.length === 0 && !flows.loading && flows.cards.length > 0 ? (
        <EmptyState icon="search" title="No flows match">
          <button
            className="btn"
            onClick={() => {
              setQuery("");
              setOwner("");
            }}
          >
            Clear filters
          </button>
        </EmptyState>
      ) : view === "board" ? (
        <Board onOpenSession={onOpenSession} lanes={lanes} onOpen={setOpenDir} openDir={openDir} loading={flows.loading && flows.cards.length === 0} />
      ) : (
        <ListView onOpenSession={onOpenSession} cards={visible} onOpen={setOpenDir} openDir={openDir} />
      )}

      {openCard ? (
        <FlowDetailSheet
          key={openCard.dir}
          cwd={cwd}
          card={openCard}
          onOpenIssue={onOpenIssue}
          version={flows.version}
          onClose={() => setOpenDir(null)}
          linked={linkedSessions(openCard.dir)}
          onWorkOn={(target) => onWorkOn(openCard, target)}
          onChanged={() => void flows.refresh()}
        />
      ) : null}
    </div>
  );
}

function Board({
  lanes,
  onOpen,
  onOpenSession,
  openDir,
  loading,
}: {
  lanes: Map<LaneId, FlowCard[]>;
  onOpen: (dir: string) => void;
  onOpenSession: Props["onOpenSession"];
  openDir: string | null;
  loading: boolean;
}) {
  const other = lanes.get("other") ?? [];
  const all = [...LANES.map((l) => ({ id: l.id as LaneId, label: l.label })), ...(other.length ? [{ id: "other" as LaneId, label: "Other" }] : [])];
  return (
    <div className="board" role="list" aria-label="Flow lanes">
      {all.map((l) => (
        <Lane key={l.id} id={l.id} label={l.label} cards={lanes.get(l.id) ?? []} onOpen={onOpen} onOpenSession={onOpenSession} openDir={openDir} loading={loading} />
      ))}
    </div>
  );
}

function Lane({
  id,
  label,
  cards,
  onOpen,
  onOpenSession,
  openDir,
  loading,
}: {
  id: LaneId;
  label: string;
  cards: FlowCard[];
  onOpen: (dir: string) => void;
  onOpenSession: Props["onOpenSession"];
  openDir: string | null;
  loading: boolean;
}) {
  const isDone = id === "done";
  const [collapsed, setCollapsed] = useState(isDone);
  const [limit, setLimit] = useState(isDone ? DONE_CAP : LANE_CAP);
  const shown = cards.slice(0, limit);

  if (collapsed) {
    return (
      <section className="lane lane-collapsed" role="listitem" aria-label={`${label}, ${cards.length} flows, collapsed`}>
        <button className="lane-expand" onClick={() => setCollapsed(false)} title={`Show ${label}`}>
          <span className={`lane-dot lane-${id}`} />
          <span className="lane-vertical">{label}</span>
          <span className="lane-count">{cards.length}</span>
        </button>
      </section>
    );
  }

  return (
    <section className="lane" role="listitem" aria-label={`${label}, ${cards.length} flows`}>
      <header className="lane-head">
        <span className={`lane-dot lane-${id}`} />
        <h2>{label}</h2>
        <span className="lane-count">{cards.length}</span>
        <div className="grow" />
        {isDone ? (
          <button className="icon-btn icon-btn-sm" onClick={() => setCollapsed(true)} aria-label="Collapse Done" title="Collapse">
            <Icon name="chevronRight" size={14} />
          </button>
        ) : null}
      </header>
      <div className="lane-body">
        {loading ? (
          <>
            <div className="card-skeleton" />
            <div className="card-skeleton" />
          </>
        ) : cards.length === 0 ? (
          <div className="lane-empty">Nothing here</div>
        ) : (
          shown.map((c) => <FlowCardView key={c.dir} card={c} onOpen={onOpen} onOpenSession={onOpenSession} selected={c.dir === openDir} />)
        )}
        {cards.length > limit ? (
          <button className="lane-more" onClick={() => setLimit((n) => n + (isDone ? DONE_CAP : LANE_CAP))}>
            Show {Math.min(cards.length - limit, isDone ? DONE_CAP : LANE_CAP)} more of {cards.length - limit}
          </button>
        ) : null}
      </div>
    </section>
  );
}

const FlowCardView = memo(function FlowCardView({
  card,
  onOpen,
  onOpenSession,
  selected,
}: {
  card: FlowCard;
  onOpen: (dir: string) => void;
  onOpenSession: Props["onOpenSession"];
  selected: boolean;
}) {
  const pct = card.tasksTotal > 0 ? Math.round((card.tasksDone / card.tasksTotal) * 100) : 0;
  const allAc = card.acTotal > 0 && card.acConfirmed >= card.acTotal;
  return (
    <article className={`flow-card${card.blocked ? " is-blocked" : ""}${card.error ? " is-broken" : ""}${selected ? " is-selected" : ""}`}>
    <button type="button" className="flow-card-main" onClick={() => onOpen(card.dir)} title={card.title}>
      <div className="flow-card-top">
        <span className="flow-id">#{card.id}</span>
        {card.blocked ? <span className="badge badge-danger">Blocked</span> : null}
        {card.error ? <span className="badge badge-danger">Unreadable</span> : null}
        {card.completionExceptions ? <span className="badge badge-warn" title="Completed with recorded exceptions">Exceptions</span> : null}
        <span className="grow" />
        <time className="flow-time" dateTime={card.updatedAt ?? undefined} title={absoluteTime(card.updatedAt)}>
          {relativeTime(card.updatedAt)}
        </time>
      </div>
      <div className="flow-title">{card.title}</div>
      {card.error ? <div className="flow-error">{card.error}</div> : null}
      {card.tasksTotal > 0 ? (
        <div className="flow-progress" aria-label={`${card.tasksDone} of ${card.tasksTotal} tasks done`}>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="flow-progress-label">
            {card.tasksDone}/{card.tasksTotal}
          </span>
        </div>
      ) : null}
      <div className="flow-meta">
        {card.acTotal > 0 ? (
          <span className={`meta-item${allAc ? " is-ok" : ""}`} title={`${card.acConfirmed} of ${card.acTotal} acceptance criteria confirmed`}>
            <Icon name="shieldCheck" size={13} />
            {card.acConfirmed}/{card.acTotal} AC
          </span>
        ) : null}
        {card.owner ? (
          <span className="meta-item" title={`Owner: ${card.owner}`}>
            <Icon name="user" size={13} />
            <span className="truncate">{card.owner}</span>
          </span>
        ) : null}
        {card.prUrl ? (
          <span className="chip chip-pr" title={card.prUrl}>
            <Icon name="pr" size={12} />
            {prLabel(card.prUrl)}
          </span>
        ) : null}
      </div>
    </button>
    <div className="card-actions"><FlowSessionButton card={card} onOpenSession={onOpenSession} /></div>
    </article>
  );
});

function FlowSessionButton({ card, onOpenSession }: { card: FlowCard; onOpenSession: Props["onOpenSession"] }) {
  const label = `Open flow #${card.id} in Sessions`;
  return <button type="button" className="icon-btn" title={label} aria-label={label}
    onClick={event => { event.stopPropagation(); onOpenSession(card); }}><Icon name="chat" size={15} /></button>;
}

function ListView({ cards, onOpen, openDir, onOpenSession }: { cards: FlowCard[]; onOpen: (dir: string) => void; openDir: string | null; onOpenSession: Props["onOpenSession"] }) {
  const [limit, setLimit] = useState(LIST_CAP);
  return (
    <div className="flow-list-wrap">
      <table className="flow-list">
        <thead>
          <tr>
            <th className="col-id">#</th>
            <th>Title</th>
            <th className="col-status">Status</th>
            <th className="col-num">Tasks</th>
            <th className="col-num">AC</th>
            <th className="col-owner">Owner</th>
            <th className="col-pr">PR</th>
            <th className="col-time">Updated</th>
            <th className="col-actions"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {cards.slice(0, limit).map((c) => (
            <tr
              key={c.dir}
              className={c.dir === openDir ? "is-selected" : undefined}
              onClick={() => onOpen(c.dir)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onOpen(c.dir);
                }
              }}
              tabIndex={0}
            >
              <td className="col-id mono">{c.id}</td>
              <td className="col-title">
                <span className="truncate">{c.title}</span>
                {c.error ? <span className="badge badge-danger">Unreadable</span> : null}
              </td>
              <td className="col-status">
                <StatusPill card={c} />
              </td>
              <td className="col-num">{c.tasksTotal ? `${c.tasksDone}/${c.tasksTotal}` : "—"}</td>
              <td className="col-num">{c.acTotal ? `${c.acConfirmed}/${c.acTotal}` : "—"}</td>
              <td className="col-owner">
                <span className="truncate">{c.owner ?? "—"}</span>
              </td>
              <td className="col-pr">{c.prUrl ? prLabel(c.prUrl) : "—"}</td>
              <td className="col-time" title={absoluteTime(c.updatedAt)}>
                {relativeTime(c.updatedAt)}
              </td>
              <td className="col-actions"><FlowSessionButton card={c} onOpenSession={onOpenSession} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {cards.length > limit ? (
        <button className="lane-more" onClick={() => setLimit((n) => n + LIST_CAP)}>
          Show {Math.min(LIST_CAP, cards.length - limit)} more of {cards.length - limit}
        </button>
      ) : null}
    </div>
  );
}

export function StatusPill({ card }: { card: FlowCard }) {
  if (card.blocked) return <span className="pill pill-blocked">Blocked</span>;
  return <span className={`pill pill-${card.status}`}>{STATUS_LABEL[card.status] ?? card.status}</span>;
}
