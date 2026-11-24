import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { displayReason, issueKey, issueViewerKey, type IssueRef, type IssueViewer } from "../../../../src/integrations/issues-contract";
import { boundSessionIndex, type SessionInfo } from "../acp/types";
import { Icon } from "../components/Icon";
import { errMessage, relativeTime } from "../lib/format";
import { requestIssues } from "../platform/issues";
import { IssueDetail, type WorkAction, type WorkProps } from "./IssueDetail";
import { IssueFilters } from "./IssueFilters";
import { IssueWorkRow } from "./IssueWorkRow";
import { DEFAULT_SOURCE, defaultFilters, groupForRow, issueGroups, issueName, issueSubject, readPreferences, SOURCES, STAGES, visibleRows,
  type Filters, type IssueSource, type ProjectBoard, type ProjectSource, type Row } from "./model";
import { isAccessError, repositoryUnavailable, useIssueCollection } from "./useIssueCollection";
import "./IssuesBoard.css";

interface Props extends WorkProps {
  cwd: string; login: string; onAccessDenied?: () => void; onSettings: () => void; request?: typeof requestIssues;
  /** The project's sessions; the work row counts those bound to an issue through their `subject`. */
  sessions?: readonly SessionInfo[];
}
type Source = IssueSource;
const NO_SESSIONS: readonly SessionInfo[] = [];

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Storage unavailable. */ }
}

export function IssuesBoard(props: Props) {
  return <AccountBoard key={JSON.stringify([props.cwd, props.login])} {...props} />;
}

function AccountBoard(props: Props) {
  const {login, cwd, request = requestIssues} = props;
  const [viewer, setViewer] = useState<IssueViewer | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!login) return;
    let active = true;
    setError("");
    void request<{viewer: IssueViewer}>(cwd, login, "viewer", {}).then(({viewer: verified}) => {
      if (verified.login.toLowerCase() !== login.toLowerCase()) throw new Error("access: GitHub account changed.");
      if (active) setViewer(verified);
    }).catch(e => { if (active) { setViewer(null); setError(errMessage(e)); } });
    return () => { active = false; };
  }, [login, cwd, request, attempt]);
  if (!viewer) return <section className="flows"><header className="flows-toolbar"><h1>Issues</h1></header>
    <div className="issues-notice" role={error ? "alert" : "status"}>
      <p>{error || (login ? "Loading GitHub account…" : "Select a GitHub account to load issues.")}</p>
      {error && <button className="btn" onClick={() => setAttempt(n => n + 1)}>Retry</button>}
      {(!login || error) && <button className="btn" onClick={props.onSettings}>GitHub accounts</button>}
    </div></section>;
  return <VerifiedBoard key={issueViewerKey(viewer)} {...props} viewer={viewer}
    verifyAgain={() => { setViewer(null); setAttempt(n => n + 1); }} />;
}

function VerifiedBoard({ viewer, verifyAgain, ...props }: Props & {viewer: IssueViewer; verifyAgain: () => void}) {
  const account = "keryx.issues." + issueViewerKey(viewer);
  // The source is the project's and the account's: switching it in one project leaves the others alone.
  // A source stored per account by an earlier Desktop is read as this project's until one is chosen here.
  const sourceKey = account + ".source." + JSON.stringify(props.cwd);
  const [denied, setDenied] = useState("");
  const [source, setSource] = useState<Source>(() => {
    const value = stored(sourceKey) ?? stored(account + ".source");
    return value && Object.hasOwn(SOURCES, value) ? value as Source : DEFAULT_SOURCE;
  });
  const sourceSelect = useRef<HTMLSelectElement>(null);
  const focusSource = useRef(false);
  // The board remounts on a source change; the fallback button that asked for it is gone, so focus the select.
  useEffect(() => {
    if (!focusSource.current) return;
    focusSource.current = false;
    sourceSelect.current?.focus();
  }, [source]);
  const [target, setTarget] = useState<ProjectSource | null>(() => {
    try {
      const value = JSON.parse(stored(account + ".project") ?? "null");
      return value && typeof value.owner === "string" && Number.isSafeInteger(value.number) && value.number > 0 ? value : null;
    } catch { return null; }
  });
  const [owner, setOwner] = useState(target?.owner ?? "");
  const [number, setNumber] = useState(target?.number.toString() ?? "");
  const change = (next: Source) => { setDenied(""); setSource(next); save(sourceKey, next); };
  // The repository source can fail where no choice of the person's is at fault: no GitHub.com remote,
  // Issues turned off (a fork), or a keryx too old to know it. Offer the source that works anywhere.
  const fallback = source === "repository" ? () => { focusSource.current = true; change("assigned"); } : undefined;
  const sourceControls = <div className="issue-sources">
    <label>Source <select ref={sourceSelect} aria-label="Issue source" value={source} onChange={e => change(e.target.value as Source)}>
      {Object.entries(SOURCES).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
    </select></label>
    {source === "project" && <form onSubmit={e => {
      e.preventDefault();
      if (!owner.trim() || !Number.isSafeInteger(+number) || +number <= 0) return;
      const next = { owner: owner.trim(), number: +number };
      setDenied(""); setTarget(next);
    }}>
      <input aria-label="GitHub Project owner" placeholder="Owner" value={owner} required onChange={e => setOwner(e.target.value)} />
      <input aria-label="GitHub Project number" type="number" placeholder="Number" min={1} value={number} required onChange={e => setNumber(e.target.value)} />
      <button className="btn btn-sm" type="submit">Open project</button>
    </form>}
  </div>;
  const key = account + ".filters." + JSON.stringify([source, source === "project" ? target : null]);
  const { onAccessDenied } = props;
  const clear = useCallback((reason: string) => {
    onAccessDenied?.();
    // Private repository names can occur in filters for more than one source.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(account + ".filters.")) localStorage.removeItem(k);
      }
    } catch { /* Storage unavailable. */ }
    save(account + ".project", null);
    setOwner(""); setNumber(""); setTarget(null); setDenied(reason);
  }, [account, onAccessDenied]);
  const remember = useCallback((project: ProjectBoard) => {
    save(account + ".project", JSON.stringify({ owner: project.owner, number: project.number }));
  }, [account]);
  if (denied) return <section className="flows"><header className="flows-toolbar"><h1>Issues</h1>{sourceControls}</header>
    <div role="alert" className="issues-notice">{denied}
      <button className="btn btn-sm" onClick={verifyAgain}>Retry</button>
      <button className="btn btn-sm" onClick={props.onSettings}>GitHub accounts</button>
    </div></section>;
  return <Collection key={key} {...props} source={source} target={target} prefsKey={key} viewer={viewer}
    sourceControls={sourceControls} clear={clear} remember={remember} fallback={fallback} />;
}

interface CollectionProps extends Props {
  prefsKey: string; source: Source; target: ProjectSource | null; sourceControls: React.ReactNode;
  viewer: IssueViewer; clear: (reason: string) => void; remember: (project: ProjectBoard) => void;
  /** Switches from the repository source to "Assigned to me"; absent for the other sources. */
  fallback?: (() => void) | undefined;
}

function Collection({ cwd, login, source, target, prefsKey, sourceControls, clear, remember, viewer, onWork, request = requestIssues,
  sessions = NO_SESSIONS, fallback }: CollectionProps) {
  const [prefs, setPrefs] = useState(() => readPreferences(prefsKey));
  const { filters, list } = prefs;
  const [filterDialog, setFilterDialog] = useState(false);
  const [selection, setSelection] = useState<Row | null>(null);
  const [detailRead, setDetailRead] = useState(0);
  const [moving, setMoving] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [mobile, setMobile] = useState(false);
  const board = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  const activeMove = useRef(false);
  const activeWork = useRef(false);
  const { snapshot, busy, error, load, invalidate, setSnapshot } = useIssueCollection(cwd, login, source, target, filters, viewer, clear, request);
  const rows = useMemo(() => visibleRows(snapshot?.rows ?? [], filters), [snapshot, filters]);
  const boundTo = useMemo(() => boundSessionIndex(sessions), [sessions]);
  const unavailable = fallback && error ? repositoryUnavailable(error, !snapshot) : null;
  const selectedKey = selection && issueKey(selection.issue.ref);
  const selectedIndex = rows.findIndex(row => issueKey(row.issue.ref) === selectedKey);
  // Refresh starts again at page one. Keep a selected later-page issue open and
  // revalidate its detail independently while further pages are available.
  const selected = rows[selectedIndex] ?? (selection && snapshot?.nextCursor && visibleRows([selection], filters).length ? selection : null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (snapshot) {
      save(prefsKey, JSON.stringify(prefs));
      if (snapshot.project) remember(snapshot.project);
    }
  }, [snapshot, prefsKey, prefs, remember]);
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    const resize = () => { if (el.clientWidth) setMobile(el.clientWidth < 740); };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(el); return () => observer.disconnect();
  }, []);

  const close = useCallback(() => setSelection(null), []);
  // On narrow layouts the opener is hidden until React commits the dismissal.
  // Restore focus after the detail's focus trap has also finished its cleanup.
  useEffect(() => {
    if (selection || !returnFocus.current) return;
    const opener = returnFocus.current;
    returnFocus.current = null;
    (opener.isConnected ? opener : title.current)?.focus();
  }, [selection]);
  useEffect(() => { if (selection && !selected && !busy) close(); }, [selection, selected, busy, close]);
  const accessLost = useCallback((reason: string) => {
    invalidate(reason); clear(reason);
  }, [invalidate, clear]);

  const show = (row: Row, el: HTMLElement) => {
    returnFocus.current = el; setSelection(row); setNotice("");
  };
  const act = async (action: WorkAction, ref: IssueRef) => {
    if (activeWork.current) return;
    activeWork.current = true; setWorking(issueKey(ref)); setNotice("");
    try { await onWork(action, ref); if (alive.current) void load(); }
    catch (cause) {
      if (!alive.current) return;
      const reason = errMessage(cause);
      if (isAccessError(reason)) accessLost(reason);
      else {
        setNotice(reason);
        // Preparation may bind a package before the session accepts its first turn.
        if (action === "prepare-flow") void load();
      }
    }
    finally { activeWork.current = false; if (alive.current) setWorking(null); }
  };
  const project = snapshot?.project;
  async function move(row: Row, destination: string | null) {
    if (!snapshot || !project?.canWrite || !project.fieldId || !row.itemId || activeMove.current || destination === row.optionId) return;
    activeMove.current = true; setMoving(row.itemId); setNotice("");
    try {
      const result = await request<{ viewer: IssueViewer; itemId: string; optionId: string | null; outcome: string }>(cwd, login, "move", {
        projectId: project.id, fieldId: project.fieldId, itemId: row.itemId, issueNodeId: row.issue.ref.nodeId,
        expectedOptionId: row.optionId ?? null, optionId: destination,
      });
      if (!alive.current) return;
      if (issueViewerKey(result.viewer) !== issueViewerKey(snapshot.viewer) || result.itemId !== row.itemId) {
        accessLost("access: Project or viewer changed. Refresh the board."); return;
      }
      const option = project.options.find(value => value.id === result.optionId)?.name ?? "No status";
      setNotice(result.outcome === "conflict" ? "Another update changed this item to " + option + "." : "Project Status: " + option);
      setSnapshot(current => current && current.project?.id === project.id ? {
        ...current, rows: current.rows.map(r => r.itemId === result.itemId ? { ...r, optionId: result.optionId } : r),
      } : current);
    } catch (cause) {
      if (!alive.current) return;
      const message = errMessage(cause);
      if (isAccessError(message)) accessLost(message);
      else { setNotice(message); void load(); }
    } finally { activeMove.current = false; if (alive.current) setMoving(null); }
  }

  /** The issue's work row and actions, each with visible text on the card, the list row and the panel alike. */
  function workActions(row: Row) {
    const issue = row.issue;
    const pending = working !== null;
    const more = issue.work?.canResumePreparation || project;
    return <>
      <IssueWorkRow issue={issue} bound={boundTo(issueSubject(issue)).length} pending={pending} onAction={action => void act(action, issue.ref)} />
      {more && <div className="card-actions issue-actions">
        {issue.work?.canResumePreparation && <button className="btn btn-sm"
          aria-label={"Resume preparation for " + issueName(issue)} title="Resume preparation" disabled={pending}
          onClick={() => void act("prepare-flow", issue.ref)}><Icon name="play" size={13} />Resume preparation</button>}
        {project && <StatusMenu row={row} project={project} pending={moving !== null} onMove={value => void move(row, value)} />}
      </div>}
    </>;
  }

  const groups = issueGroups(project, filters.state);
  const activeFilters = Object.entries(filters).filter(([k, v]) => k !== "text" && v !== defaultFilters[k as keyof Filters]);
  const setFilters = (f: Filters) => setPrefs(p => ({ ...p, filters: f }));
  const dragItem = useRef<Row | null>(null);
  return <div className="issue-workspace" ref={board}>
    <section className="flows issues-main" hidden={mobile && !!selected}>
      <header className="flows-toolbar">
        <div className="flows-heading"><h1 tabIndex={-1} ref={title}>Issues</h1>{snapshot && <span className="count-label">{snapshot.rows.length} loaded</span>}</div>
        {sourceControls}
        <input type="search" aria-label="Search issues" placeholder="Search by title or #number" value={filters.text} onChange={e => setFilters({ ...filters, text: e.target.value })} />
        <button className="btn btn-sm" onClick={() => setFilterDialog(true)}><Icon name="list" size={14} />Filters{activeFilters.length > 0 && " (" + activeFilters.length + ")"}</button>
        <div className="segmented" aria-label="Issue layout">{[false, true].map(asList => <button key={String(asList)} aria-pressed={list === asList}
          onClick={() => setPrefs(p => ({ ...p, list: asList }))}><Icon name={asList ? "list" : "board"} size={14} />{asList ? "List" : "Board"}</button>)}</div>
        <button className="btn btn-sm" disabled={busy} onClick={() => { setDetailRead(n => n + 1); void load(); }}><Icon name="refresh" size={14} />Refresh</button>
      </header>
      {!isAccessError(error) && <div className="review-context"><strong>{snapshot?.viewer.host ?? "GitHub"} · {login}</strong>
        {project && <span>{project.title}</span>}{snapshot && <span>Read {snapshot.readAt.toLocaleTimeString()}</span>}
        {activeFilters.map(([key, value]) => <button key={key} className="btn btn-sm" aria-label={"Remove " + key + " filter"} onClick={() => setFilters({ ...filters, [key]: defaultFilters[key as keyof Filters] })}>{key} · {value} ×</button>)}
      </div>}
      {error && (unavailable && fallback ? <div className="issues-notice" role="alert">
        <p>{displayReason(error)}</p>
        <p>This project's repository issues are not available here.
          {unavailable === "older" && " If this keryx is older than Desktop, update keryx or choose Bundled keryx in Settings → Desktop."}</p>
        <button className="btn btn-sm" onClick={fallback}>Show issues assigned to me</button>
      </div> : <div className="issues-notice" role="alert">{error} {snapshot && "Showing the last available snapshot."}
        <button className="btn btn-sm" onClick={() => void load()}>Retry</button>
      </div>)}
      {notice && <p className="issues-notice" role="status">{notice}</p>}
      {busy && <p className="issues-notice" role="status">Loading issues…</p>}
      {project && (!project.canWrite || !project.fieldId) && <p className="issues-notice">{project.fieldId ? "Read-only access to this Project." : "Project Status field unavailable."}</p>}
      {snapshot?.incomplete && <p className="issues-notice" role="status">GitHub returned partial results.</p>}
      {!!snapshot && rows.length === 0 && <p className="issues-notice">{snapshot.nextCursor ? "No matching issues on the loaded pages." : "No matching issues."}</p>}
      {snapshot && (list || (project && !project.fieldId) ? <div className="flow-list-wrap"><table className="flow-list issue-table"><thead><tr>
        <th>Issue</th><th>GitHub state</th><th>Keryx stage</th>{project && <th>Project Status</th>}<th>Assignees</th><th>Updated</th><th>Actions</th>
      </tr></thead><tbody>{rows.map(r => <tr key={issueKey(r.issue.ref)}>
        <td><button className="review-list-link" onClick={e => show(r, e.currentTarget)}>{issueName(r.issue)} {r.issue.title}</button></td>
        <td>{r.issue.state}</td><td>{STAGES[r.issue.work?.stage ?? "none"]}{r.issue.work?.reason && <small>{r.issue.work.reason}</small>}</td>
        {project && <td>{project.options.find(o => o.id === r.optionId)?.name ?? "No status"}</td>}
        <td>{r.issue.assignees.join(", ") || "Unassigned"}</td><td>{relativeTime(r.issue.updatedAt)}</td><td>{workActions(r)}</td></tr>)}</tbody></table></div>
      : <div className="board issue-lanes">{groups.map(group => {
        const cards = rows.filter(r => groupForRow(r, !!project) === group.id);
        return <section className="lane" key={group.id} aria-label={group.label}
          onDragOver={e => { if (dragItem.current && project?.canWrite && project.fieldId) e.preventDefault(); }}
          onDrop={e => { e.preventDefault(); const row = dragItem.current; dragItem.current = null; if (row) void move(row, group.id === "unassigned" ? null : group.id); }}>
          <header className="lane-head"><h2>{group.label}</h2><span className="lane-count">{cards.length}</span></header>
          <div className="lane-body">{cards.map(r => <article key={issueKey(r.issue.ref)} className="flow-card"
            draggable={!!project?.canWrite && !!project.fieldId && !moving} onDragStart={e => {
              dragItem.current = r; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.itemId ?? "");
            }} onDragEnd={() => { dragItem.current = null; }}>
            <button className="flow-card-main" onClick={e => show(r, e.currentTarget)}>
              <span className="flow-id">{issueName(r.issue)}</span><span className="flow-title">{r.issue.title}</span>
              <span className="flow-meta">
                <span className="badge">{r.issue.state}</span>
                <span>{r.issue.assignees.join(", ") || "Unassigned"}</span>
              </span>
              {r.issue.labels.length > 0 && <span className="issue-labels" title={r.issue.labels.join(", ")}>{r.issue.labels.join(" · ")}</span>}
              {r.issue.work?.reason && <span className="issue-labels">{r.issue.work.reason}</span>}
            </button>{workActions(r)}</article>)}
          </div></section>;
      })}</div>)}
      {snapshot?.nextCursor && <button className="btn issue-more" disabled={busy} onClick={() => void load(true)}>Load more issues</button>}
    </section>
    {selected && snapshot && <IssueDetail key={JSON.stringify([issueKey(selected.issue.ref), detailRead])} cwd={cwd} login={login} viewer={snapshot.viewer} row={selected.issue}
      request={request} mobile={mobile} onAccessLost={accessLost} close={close} actions={workActions(selected)}
      onPrevious={selectedIndex > 0 ? () => setSelection(rows[selectedIndex - 1]!) : undefined}
      onNext={selectedIndex < rows.length - 1 ? () => setSelection(rows[selectedIndex + 1]!) : undefined} />}
    {filterDialog && <IssueFilters filters={filters} project={project} apply={f => { setFilters(f); setFilterDialog(false); }} close={() => setFilterDialog(false)} />}
  </div>;
}

function StatusMenu({ row, project, pending, onMove }: { row: Row; project: ProjectBoard; pending: boolean; onMove: (v: string | null) => void }) {
  return <select className="issue-move" value={row.optionId ?? ""} disabled={pending || !project.canWrite || !project.fieldId}
    aria-label={"Change Project Status for " + issueName(row.issue)} title={project.canWrite ? "Change Project Status" : "Read-only Project"}
    onChange={e => onMove(e.target.value || null)}>
    <option value="">No status</option>{project.options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
  </select>;
}
