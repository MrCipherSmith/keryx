import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import { Dialog, Spinner } from "../components/ui";
import { absoluteTime } from "../lib/format";
import { partitionSubagents, sortSubagents, statusLabel, type Subagent } from "./activity";
import { SubagentDetail } from "./ActivityPanel";
import "./SubagentArchive.css";

interface Props {
  title: string;
  subagents: readonly Subagent[];
  loading: boolean;
  unavailable: boolean;
  onRetry: () => void;
  onClose: () => void;
}

function StartedAt({ timestamp }: { timestamp?: number }) {
  const iso = timestamp == null ? null : new Date(timestamp).toJSON();
  return iso ? <time dateTime={iso}>{absoluteTime(iso)}</time> : null;
}

export function SubagentArchive({ title, subagents, loading, unavailable, onRetry, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>();
  const [limit, setLimit] = useState(100);
  const { ordered, archived } = useMemo(() => ({
    ordered: sortSubagents(subagents),
    archived: new Set(partitionSubagents(subagents).archived.map(agent => agent.id)),
  }), [subagents]);
  const needle = query.trim().toLowerCase();
  const rows = ordered.filter(agent => agent.label.toLowerCase().includes(needle));
  const current = rows.find(agent => agent.id === selected) ?? rows[0];
  return createPortal(<div className="subagent-archive"><Dialog width={1000} title={<>
    Subagent archive <small className="archive-parent" title={title}>{title}</small>
  </>} onClose={onClose} footer={<button className="btn btn-sm" onClick={onClose}>Close</button>}>
    {loading ? <Spinner label="Loading subagent history" /> : unavailable ?
      <div role="alert" className="inline-banner tone-warn">Could not load this session’s subagents.
        <button className="btn btn-sm" onClick={onRetry}>Retry</button>
      </div> : <div className="archive-panes">
        <div className="archive-index">
          <label className="archive-search"><Icon name="search" size={14} />
            <input type="search" aria-label="Filter subagents by name" placeholder="Filter by name" data-autofocus value={query}
              onChange={event => { setQuery(event.currentTarget.value); setLimit(100); }} />
          </label>
          <ul className="archive-list" aria-label="Subagents">
            {rows.slice(0, limit).map(agent => <li key={agent.id}>
              <button className="archive-row" aria-pressed={agent.id === current?.id} onClick={() => setSelected(agent.id)}>
                <span className="archive-label">{agent.label}</span>
                <span className="archive-row-meta">
                  <span className={`session-child-dot status-${agent.status}`} aria-hidden="true" />
                  {statusLabel(agent.status)}{archived.has(agent.id) && " · Archived"}
                </span>
                <StartedAt timestamp={agent.startedAt} />
              </button>
            </li>)}
            {rows.length > limit && <li><button className="btn btn-sm" onClick={() => setLimit(value => value + 100)}>Show more subagents</button></li>}
          </ul>
          {!rows.length && <p role="status" className="archive-empty">{needle ? "No matching subagents." : "No subagents recorded."}</p>}
        </div>
        <section className="archive-transcript" aria-label="Subagent session" tabIndex={0} key={current?.id ?? "empty"}>
          {current && <>
            <SubagentDetail agent={current} />
            {!current.entries.some(entry => entry.kind !== "task") && <p className="archive-empty">No log entries recorded.</p>}
          </>}
        </section>
      </div>}
  </Dialog></div>, document.body);
}
