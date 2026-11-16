import { memo, useMemo, useState } from "react";
import type { SessionInfo } from "../acp/types";
import { absoluteTime, relativeTime } from "../lib/format";
import { MOD } from "../lib/prefs";
import { Icon } from "../components/Icon";

interface Props {
  sessions: SessionInfo[];
  currentId: string | null;
  currentTitle: string | null;
  busy: boolean;
  ready: boolean;
  onNew: () => void;
  onLoad: (id: string) => void;
  onCollapse: () => void;
}

function dayBucket(iso: string | null | undefined): string {
  if (!iso) return "Older";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Older";
  const d = new Date(t);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (t >= start) return "Today";
  if (t >= start - 86400000) return "Yesterday";
  if (t >= start - 6 * 86400000) return "Previous 7 days";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export const SessionSidebar = memo(function SessionSidebar({ sessions, currentId, currentTitle, busy, ready, onNew, onLoad, onCollapse }: Props) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? sessions.filter((s) => (s.title ?? "").toLowerCase().includes(needle)) : sessions;
  }, [sessions, q]);
  const hasCurrent = currentId !== null && sessions.some((s) => s.sessionId === currentId);

  let last = "";
  return (
    <aside className="session-sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <h2>Sessions</h2>
        <div className="grow" />
        <button className="icon-btn" onClick={onNew} disabled={!ready || busy} title={`New session (${MOD}N)`} aria-label="New session">
          <Icon name="plus" size={16} />
        </button>
        <button className="icon-btn" onClick={onCollapse} title="Hide sessions" aria-label="Hide sessions">
          <Icon name="chevronRight" size={14} className="flip" />
        </button>
      </div>
      {sessions.length > 6 ? (
        <div className="sidebar-search">
          <Icon name="search" size={13} />
          <input type="search" placeholder="Search sessions" aria-label="Search sessions" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      ) : null}
      <ul className="session-list">
        {!hasCurrent && currentId ? (
          <li>
            <div className="session-item is-current" aria-current="true">
              <span className="session-item-title truncate">{currentTitle?.trim() || "New session"}</span>
              <span className="session-item-time">now</span>
            </div>
          </li>
        ) : null}
        {list.map((s) => {
          const bucket = dayBucket(s.updatedAt);
          const header = bucket !== last ? bucket : null;
          last = bucket;
          const current = s.sessionId === currentId;
          return (
            <li key={s.sessionId}>
              {header ? <div className="session-bucket">{header}</div> : null}
              <button
                className={`session-item${current ? " is-current" : ""}`}
                aria-current={current ? "true" : undefined}
                onClick={() => onLoad(s.sessionId)}
                disabled={busy && !current}
                title={busy && !current ? "Wait for the current turn to finish" : absoluteTime(s.updatedAt)}
              >
                <span className="session-item-title truncate">{s.title?.trim() || "Untitled session"}</span>
                <span className="session-item-time">{relativeTime(s.updatedAt)}</span>
              </button>
            </li>
          );
        })}
        {sessions.length === 0 && !currentId ? <li className="sidebar-empty">Sessions you start here are saved by keryx and listed here.</li> : null}
        {sessions.length > 0 && list.length === 0 ? <li className="sidebar-empty">No session matches “{q}”.</li> : null}
      </ul>
    </aside>
  );
});
