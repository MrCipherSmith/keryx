import { memo, useCallback, useMemo, useState } from "react";
import { sessionFlags, type SessionInfo } from "../acp/types";
import { absoluteTime, relativeTime } from "../lib/format";
import { MOD, setPrefs, usePrefs } from "../lib/prefs";
import { Icon } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { Dialog, Spinner } from "../components/ui";
import { lostText, type SessionMark } from "./reducer";
import { countViews, groupSessions, type SidebarView } from "./sessionGroups";

interface Props {
  sessions: SessionInfo[];
  /** Every session the window has, held or released, with its marks. */
  marks: Readonly<Record<string, SessionMark>>;
  /** Sessions whose session/load is in flight. */
  loadingIds: readonly string[];
  currentId: string | null;
  ready: boolean;
  /** keryx can archive, pin and trash (older keryx: no ⋯ menu, no Archived view). */
  canOrganize: boolean;
  onNew: () => void;
  onLoad: (id: string) => void;
  onCollapse: () => void;
  onSetFlags: (
    id: string,
    change: { archived?: boolean; pinned?: boolean },
  ) => void;
  /** Resolves true when the session went to the trash. */
  onTrash: (id: string) => Promise<boolean>;
}

/** What the sidebar says about a session: working, waiting for you, or loading. */
function Mark({
  mark,
  loading,
}: {
  mark: SessionMark | undefined;
  loading: boolean;
}) {
  if (mark?.waiting) {
    return (
      <span
        className="session-item-mark is-waiting"
        title="Waiting for your answer"
        aria-label="Waiting for your answer"
      >
        <Icon name="alert" size={12} />
      </span>
    );
  }
  if (mark?.busy || loading) {
    return (
      <span
        className="session-item-mark"
        title={loading ? "Opening" : "Working"}
        aria-label={loading ? "Opening" : "Working"}
      >
        <Spinner size={11} />
      </span>
    );
  }
  return null;
}

function markTitle(mark: SessionMark | undefined, fallback: string): string {
  if (mark && !mark.held)
    return `${lostText(mark.lostReason)}; opening it loads it again`;
  return fallback;
}

const titleOf = (s: SessionInfo, mark: SessionMark | undefined): string =>
  (mark?.title ?? s.title)?.trim() || "Untitled session";

export const SessionSidebar = memo(function SessionSidebar({
  sessions,
  marks,
  loadingIds,
  currentId,
  ready,
  canOrganize,
  onNew,
  onLoad,
  onCollapse,
  onSetFlags,
  onTrash,
}: Props) {
  const [q, setQ] = useState("");
  const [view, setView] = useState<SidebarView>("active");
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<SessionInfo | null>(null);
  const [trashing, setTrashing] = useState(false);
  const prefs = usePrefs();
  const collapsed = useMemo(
    () =>
      new Set(
        Array.isArray(prefs.collapsedGroups) ? prefs.collapsedGroups : [],
      ),
    [prefs.collapsedGroups],
  );
  const toggleGroup = useCallback(
    (label: string) => {
      const next = new Set(collapsed);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      setPrefs({ collapsedGroups: [...next] });
    },
    [collapsed],
  );

  const counts = useMemo(() => countViews(sessions), [sessions]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? sessions.filter((s) => (s.title ?? "").toLowerCase().includes(needle))
      : sessions;
    return groupSessions(list, view);
  }, [sessions, q, view]);
  // Sessions the window has that keryx has not listed yet (a new one, before its first save).
  const unlisted = useMemo(() => {
    const listed = new Set(sessions.map((s) => s.sessionId));
    return Object.entries(marks).filter(([sid]) => !listed.has(sid));
  }, [sessions, marks]);
  const loading = useMemo(() => new Set(loadingIds), [loadingIds]);
  const shownCount = groups.reduce((n, g) => n + g.sessions.length, 0);

  const menuSession = menu
    ? sessions.find((s) => s.sessionId === menu.id)
    : undefined;
  const menuItems = (s: SessionInfo): MenuItem[] => {
    const flags = sessionFlags(s);
    const archived = flags.archivedAt !== undefined;
    const pinned = flags.pinnedAt !== undefined;
    const busy = marks[s.sessionId]?.busy === true;
    return [
      ...(archived
        ? []
        : [
            {
              id: "pin",
              label: pinned ? "Unpin" : "Pin",
              icon: "pin" as const,
              onSelect: () => onSetFlags(s.sessionId, { pinned: !pinned }),
            },
          ]),
      {
        id: "archive",
        label: archived ? "Unarchive" : "Archive",
        icon: "archive",
        onSelect: () => onSetFlags(s.sessionId, { archived: !archived }),
      },
      { kind: "separator", id: "sep" },
      {
        id: "trash",
        label: "Move to Trash…",
        icon: "trash",
        disabled: busy,
        description: busy ? "Stop its turn first" : undefined,
        onSelect: () => setConfirm(s),
      },
    ];
  };

  const trash = async () => {
    if (!confirm) return;
    setTrashing(true);
    const ok = await onTrash(confirm.sessionId);
    setTrashing(false);
    if (ok) setConfirm(null);
  };

  return (
    <aside className="session-sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <h2>Sessions</h2>
        <div className="grow" />
        <button
          className="icon-btn"
          onClick={onNew}
          disabled={!ready}
          title={`New session (${MOD}N)`}
          aria-label="New session"
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          className="icon-btn"
          onClick={onCollapse}
          title="Hide sessions"
          aria-label="Hide sessions"
        >
          <Icon name="chevronRight" size={14} className="flip" />
        </button>
      </div>
      {canOrganize ? (
        <div
          className="sidebar-views"
          role="radiogroup"
          aria-label="Which sessions"
        >
          {(["active", "archived"] as const).map((v) => (
            <button
              key={v}
              role="radio"
              aria-checked={view === v}
              className={`sidebar-view${view === v ? " is-on" : ""}`}
              onClick={() => setView(v)}
            >
              {v === "active" ? "Active" : "Archived"}
              <span className="sidebar-view-count">{counts[v]}</span>
            </button>
          ))}
        </div>
      ) : null}
      {sessions.length > 6 ? (
        <div className="sidebar-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            placeholder="Search sessions"
            aria-label="Search sessions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      ) : null}
      <ul className="session-list">
        {view === "active"
          ? unlisted.map(([sid, mark]) => {
              const current = sid === currentId;
              return (
                <li key={sid}>
                  <button
                    className={`session-item${current ? " is-current" : ""}${mark.held ? "" : " is-released"}`}
                    aria-current={current ? "true" : undefined}
                    onClick={() => onLoad(sid)}
                    title={markTitle(mark, "Open in this window")}
                  >
                    <span className="session-item-title truncate">
                      {mark.title?.trim() || "New session"}
                    </span>
                    <Mark mark={mark} loading={loading.has(sid)} />
                    <span className="session-item-time">now</span>
                  </button>
                </li>
              );
            })
          : null}
        {groups.map((g) => {
          const folded = collapsed.has(g.label);
          return (
            <li key={g.label} className="session-group">
              <button
                className="session-bucket"
                aria-expanded={!folded}
                onClick={() => toggleGroup(g.label)}
              >
                <Icon
                  name={folded ? "chevronRight" : "chevronDown"}
                  size={11}
                />
                <span>{g.label}</span>
                {folded ? (
                  <span className="session-bucket-count">
                    {g.sessions.length}
                  </span>
                ) : null}
              </button>
              {folded ? null : (
                <ul className="session-group-list">
                  {g.sessions.map((s) => {
                    const current = s.sessionId === currentId;
                    const mark = marks[s.sessionId];
                    const menuOpen = menu?.id === s.sessionId;
                    return (
                      <li
                        key={s.sessionId}
                        className={`session-row${menuOpen ? " is-menu" : ""}`}
                      >
                        <button
                          className={`session-item${current ? " is-current" : ""}${mark && !mark.held ? " is-released" : ""}`}
                          aria-current={current ? "true" : undefined}
                          onClick={() => onLoad(s.sessionId)}
                          title={markTitle(mark, absoluteTime(s.updatedAt))}
                        >
                          <span className="session-item-title truncate">
                            {titleOf(s, mark)}
                          </span>
                          <Mark
                            mark={mark}
                            loading={loading.has(s.sessionId)}
                          />
                          <span className="session-item-time">
                            {relativeTime(s.updatedAt)}
                          </span>
                        </button>
                        {canOrganize ? (
                          <button
                            className="icon-btn session-more"
                            aria-label={`More for ${titleOf(s, mark)}`}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            title="More"
                            disabled={!ready}
                            onClick={(e) =>
                              setMenu(
                                menuOpen
                                  ? null
                                  : {
                                      id: s.sessionId,
                                      anchor: e.currentTarget,
                                    },
                              )
                            }
                          >
                            <Icon name="more" size={14} />
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        {view === "active" && sessions.length === 0 && unlisted.length === 0 ? (
          <li className="sidebar-empty">
            Sessions you start here are saved by keryx and listed here.
          </li>
        ) : null}
        {view === "archived" && counts.archived === 0 ? (
          <li className="sidebar-empty">
            No archived sessions. Archive one from its ⋯ menu.
          </li>
        ) : null}
        {q.trim() && shownCount === 0 && counts[view] > 0 ? (
          <li className="sidebar-empty">No session matches “{q}”.</li>
        ) : null}
      </ul>
      {menu && menuSession ? (
        <Menu
          anchor={menu.anchor}
          items={menuItems(menuSession)}
          onClose={() => setMenu(null)}
          label="Session actions"
          width={220}
        />
      ) : null}
      {confirm ? (
        <Dialog
          title="Move session to Trash?"
          icon="trash"
          tone="danger"
          onClose={trashing ? null : () => setConfirm(null)}
          footer={
            <>
              <button
                className="btn"
                onClick={() => setConfirm(null)}
                disabled={trashing}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => void trash()}
                disabled={trashing}
              >
                {trashing ? <Spinner size={12} /> : null} Move to Trash
              </button>
            </>
          }
        >
          <p>
            “{titleOf(confirm, marks[confirm.sessionId])}” leaves keryx and goes
            to the system Trash. You can restore it from there until the Trash
            is emptied.
          </p>
        </Dialog>
      ) : null}
    </aside>
  );
});
