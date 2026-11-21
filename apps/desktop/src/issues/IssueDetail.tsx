import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { issueKey, issueViewerKey, type IssueComment, type IssueDetail as Detail, type IssuePage, type IssueRef, type IssueSummary, type IssueViewer } from "../../../../src/integrations/issues-contract";
import { Icon } from "../components/Icon";
import { useEscape, useFocusTrap } from "../components/ui";
import { errMessage, relativeTime } from "../lib/format";
import { openExternal } from "../platform/commands";
import { requestIssues } from "../platform/issues";
import { issueName, STAGES } from "./model";
import { isAccessError } from "./useIssueCollection";
import { IssueMarkdown, webUrl } from "./IssueMarkdown";

export type WorkAction = "open-session" | "prepare-flow" | "open-flow";
export interface WorkProps {
  onWork: (action: WorkAction, ref: IssueRef, flowDir?: string) => Promise<void>;
}

interface Props {
  cwd: string; login: string; viewer: IssueViewer; row: IssueSummary; request: typeof requestIssues;
  close: () => void; onAccessLost: (reason: string) => void; mobile: boolean;
  actions: ReactNode; onPrevious?: () => void; onNext?: () => void;
}

export function IssueDetail({ cwd, login, viewer, row, request, close, onAccessLost, mobile, actions, onPrevious, onNext }: Props) {
  const panel = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(550);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [commentError, setCommentError] = useState("");
  const [busyComments, setBusyComments] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const identity = issueViewerKey(viewer);
  const issue = row.ref;
  const active = useRef<HTMLButtonElement>(null);
  useFocusTrap(panel, mobile);
  useEscape(close);
  useLayoutEffect(() => { active.current?.focus(); }, [issue.nodeId]);

  const readComments = useCallback(async (next: string | null, gen: number) => {
    if (busy.current) return;
    busy.current = true; setBusyComments(true); setCommentError("");
    try {
      const result = await request<IssuePage<IssueComment>>(cwd, login, "comments", { ref: issue, cursor: next });
      if (generation.current !== gen) return;
      if (issueViewerKey(result.viewer) !== identity) { onAccessLost("access: GitHub account changed."); return; }
      setComments(old => [...new Map([...(next ? old : []), ...result.items].map(c => [c.id, c])).values()]);
      setCursor(result.nextCursor);
    } catch (e) {
      if (generation.current !== gen) return;
      const reason = errMessage(e); if (isAccessError(reason)) onAccessLost(reason); else setCommentError(reason);
    } finally {
      if (generation.current === gen) { busy.current = false; setBusyComments(false); }
    }
  }, [cwd, login, issue, identity, onAccessLost, request]);

  useEffect(() => {
    const gen = ++generation.current;
    busy.current = false;
    setError(""); setDetail(null); setComments([]); setCursor(null); setCommentError(""); setBusyComments(false);
    void request<{ viewer: IssueViewer; issue: Detail }>(cwd, login, "detail", { ref: issue }).then(response => {
      if (gen !== generation.current) return;
      if (identity !== issueViewerKey(response.viewer) || issueKey(response.issue.ref) !== issueKey(issue)) {
        onAccessLost("access: The issue or GitHub account changed."); return;
      }
      setDetail(response.issue);
      void readComments(null, gen);
    }).catch(e => {
      if (gen !== generation.current) return;
      const reason = errMessage(e); if (isAccessError(reason)) onAccessLost(reason); else setError(reason);
    });
    return () => { generation.current++; };
  }, [cwd, login, request, issue, identity, retry, readComments, onAccessLost]);

  const current = detail ?? row;
  const clamp = (v: number) => Math.max(360, Math.min(Math.max(360, (panel.current?.parentElement?.clientWidth ?? 1300) - 280), v));
  const drag = useRef<{ x: number; width: number } | null>(null);
  return <aside ref={panel} className="issue-detail side-panel" role={mobile ? "dialog" : "region"} aria-modal={mobile || undefined}
    aria-label={"Issue " + issueName(row)} style={mobile ? undefined : { width }} onClick={e => {
      const link = (e.target as Element).closest("a");
      if (!link) return;
      e.preventDefault();
      const url = webUrl(link.getAttribute("href"));
      if (url) void openExternal(url).catch(cause => setError(errMessage(cause)));
    }}>
    {!mobile && <div className="side-resize issue-resize" role="separator" aria-label="Issue details width" aria-orientation="vertical"
      aria-valuemin={360} aria-valuemax={clamp(Infinity)} aria-valuenow={clamp(width)} tabIndex={0}
      onKeyDown={e => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setWidth(clamp(width + (e.key === "ArrowLeft" ? 24 : -24))); }
      }}
      onPointerDown={e => { drag.current = { x: e.clientX, width: panel.current!.getBoundingClientRect().width }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (drag.current) setWidth(clamp(drag.current.width + drag.current.x - e.clientX)); }}
      onLostPointerCapture={() => { drag.current = null; }} />}
    <header className="sheet-head">
      <div className="sheet-head-row"><span className="flow-id">{issueName(row)}</span><span className="spacer" />
        <button className="icon-btn" aria-label="Previous issue" disabled={!onPrevious} onClick={onPrevious}><Icon name="arrowLeft" /></button>
        <button className="icon-btn" aria-label="Next issue" disabled={!onNext} onClick={onNext}><Icon name="arrowRight" /></button>
        <button ref={active} className="icon-btn" aria-label="Close issue" onClick={close}><Icon name="x" /></button>
      </div>
      <h2>{current.title}</h2><div className="issue-detail-actions">{actions}
        <a className="btn btn-sm" href={issue.url}>Open in GitHub <Icon name="external" size={14} /></a>
      </div>
    </header>
    <div className="issue-detail-scroll">
      <dl className="issue-properties"><dt>GitHub state</dt><dd>{current.state}{detail?.stateReason && " · " + detail.stateReason}</dd>
        <dt>Keryx stage</dt><dd>{STAGES[row.work?.stage ?? "none"]}{row.work?.reason && " · " + row.work.reason}</dd>
        <dt>Author</dt><dd>{current.author || "Deleted account"}</dd><dt>Assignees</dt><dd>{current.assignees.join(", ") || "Unassigned"}</dd>
        <dt>Labels</dt><dd>{current.labels.join(", ") || "No labels"}</dd><dt>Created</dt><dd>{new Date(current.createdAt).toLocaleString()}</dd>
        <dt>Updated</dt><dd>{new Date(current.updatedAt).toLocaleString()}</dd>
      </dl>
      {error && <p role="alert">{error} <button className="btn btn-sm" onClick={() => setRetry(i => i + 1)}>Retry</button></p>}
      {detail ? <>
        <section><h3>Description</h3>{detail.body ? <IssueMarkdown body={detail.body} issue={issue} /> : <p>No description.</p>}</section>
        <section><h3>Comments <span className="count-label">{comments.length} loaded</span></h3>
          {comments.map(item => <article key={item.id} className="review-detail-message">
            <strong>{item.author}</strong>{" · "}<a href={item.url}>{relativeTime(item.createdAt)}</a><IssueMarkdown body={item.body} issue={issue} />
          </article>)}
          {!busyComments && !commentError && !cursor && !comments.length && <p>No comments yet.</p>}
          {busyComments && <p role="status">Loading comments…</p>}
          {commentError && <p role="alert">{commentError}</p>}
          {(commentError || cursor) && <button className="btn btn-sm" disabled={busyComments} onClick={() => void readComments(cursor, generation.current)}>
            {commentError ? "Retry comments" : "Load more comments"}</button>}
        </section>
      </> : !error && <p role="status">Loading issue…</p>}
    </div>
  </aside>;
}
