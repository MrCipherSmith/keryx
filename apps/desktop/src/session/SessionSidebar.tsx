import { memo, useMemo, useState } from "react";
import type { SessionInfo } from "../acp/types";
import { absoluteTime, relativeTime } from "../lib/format";
import { MOD } from "../lib/prefs";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import type { SessionMark } from "./reducer";

interface Props {
  sessions: SessionInfo[];
  /** Every session the window has, held or released, with its marks. */
  marks: Readonly<Record<string, SessionMark>>;
  /** Sessions whose session/load is in flight. */
  loadingIds: readonly string[];
  currentId: string | null;
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

/** What the sidebar says about a session: working, waiting for you, or loading. */
function Mark({ mark, loading }: { mark: SessionMark | undefined; loading: boolean }) {
  if (mark?.waiting) {
    return (
      <span className="session-item-mark is-waiting" title="Waiting for your answer" aria-label="Waiting for your answer">
        <Icon name="alert" size={12} />
      </span>
    );
  }
  if (mark?.busy || loading) {
    return (
      <span className="session-item-mark" title={loading ? "Opening" : "Working"} aria-label={loading ? "Opening" : "Working"}>
        <Spinner size={11} />
      </span>
    );
  }
  return null;
}

function markTitle(mark: SessionMark | undefined, fallback: string): string {
  if (mark && !mark.held) return "Closed by keryx to save memory; opening it loads it again";
  return fallback;
}

export const SessionSidebar = memo(function SessionSidebar({ sessions, marks, loadingIds, currentId, ready, onNew, onLoad, onCollapse }: Props) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? sessions.filter((s) => (s.title ?? "").toLowerCase().includes(needle)) : sessions;
  }, [sessions, q]);
  // Sessions the window has that keryx has not listed yet (a new one, before its first save).
  const unlisted = useMemo(() => {
    const listed = new Set(sessions.map((s) => s.sessionId));
    return Object.entries(marks).filter(([sid]) => !listed.has(sid));
  }, [sessions, marks]);
  const loading = useMemo(() => new Set(loadingIds), [loadingIds]);

  let last = "";
  return (
    <aside className="session-sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <h2>Sessions</h2>
        <div className="grow" />
        <button className="icon-btn" onClick={onNew} disabled={!ready} title={`New session (${MOD}N)`} aria-label="New session">
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
        {unlisted.map(([sid, mark]) => {
          const current = sid === currentId;
          return (
            <li key={sid}>
              <button
                className={`session-item${current ? " is-current" : ""}${mark.held ? "" : " is-released"}`}
                aria-current={current ? "true" : undefined}
                onClick={() => onLoad(sid)}
                title={markTitle(mark, "Open in this window")}
              >
                <span className="session-item-title truncate">{mark.title?.trim() || "New session"}</span>
                <Mark mark={mark} loading={loading.has(sid)} />
                <span className="session-item-time">now</span>
              </button>
            </li>
          );
        })}
        {list.map((s) => {
          const bucket = dayBucket(s.updatedAt);
          const header = bucket !== last ? bucket : null;
          last = bucket;
          const current = s.sessionId === currentId;
          const mark = marks[s.sessionId];
          return (
            <li key={s.sessionId}>
              {header ? <div className="session-bucket">{header}</div> : null}
              <button
                className={`session-item${current ? " is-current" : ""}${mark && !mark.held ? " is-released" : ""}`}
                aria-current={current ? "true" : undefined}
                onClick={() => onLoad(s.sessionId)}
                title={markTitle(mark, absoluteTime(s.updatedAt))}
              >
                <span className="session-item-title truncate">{(mark?.title ?? s.title)?.trim() || "Untitled session"}</span>
                <Mark mark={mark} loading={loading.has(s.sessionId)} />
                <span className="session-item-time">{relativeTime(s.updatedAt)}</span>
              </button>
            </li>
          );
        })}
        {sessions.length === 0 && unlisted.length === 0 ? <li className="sidebar-empty">Sessions you start here are saved by keryx and listed here.</li> : null}
        {sessions.length > 0 && list.length === 0 ? <li className="sidebar-empty">No session matches “{q}”.</li> : null}
      </ul>
    </aside>
  );
});
