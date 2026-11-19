import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DeskReviewerSession, DeskRun } from "../../../../src/review/desk-run-types";
import { Dialog } from "../components/ui";
import { Icon } from "../components/Icon";
import { absoluteTime, errMessage } from "../lib/format";
import { runActive } from "./useReviewRuns";

const status = {
  planned: "Planned", running: "In progress", completed: "Completed", failed: "Failed",
  cancelled: "Cancelled", partial: "Partial", unknown: "Unrecorded",
};
export type LoadReviewAttempt = (id: string) => Promise<DeskRun | undefined>;

function elapsed(start: string | undefined, end: string | undefined, active: boolean) {
  if (!start || (!end && !active)) return null;
  const seconds = Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ReviewerDialog({ session, error, loading, active, onClose, onRetry }: {
  session: DeskReviewerSession; error: string; loading: boolean; active: boolean; onClose: () => void; onRetry: () => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const events = session.activity ?? [];
  useLayoutEffect(() => {
    if (following.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [session.activity]);
  const duration = elapsed(session.startedAt, session.finishedAt, active && session.state === "running");
  const usage = session.usage;
  const counts = [
    usage?.inputTokens != null && `${usage.inputTokens.toLocaleString()} in`,
    usage?.outputTokens != null && `${usage.outputTokens.toLocaleString()} out`,
    usage?.totalTokens != null && `${usage.totalTokens.toLocaleString()} total`,
  ].filter(Boolean);
  return createPortal(<Dialog width={560} onClose={onClose} title={<span className="review-session-heading">
    <span>{session.reviewer}</span><span className="review-session-status" data-state={session.state}>{status[session.state]}</span>
    <small title={session.id}>{[session.provider, session.model, `Session ${session.id.slice(0, 8)}`].filter(Boolean).join(" · ")}</small>
  </span>} footer={<>
    <div className="review-session-footer">
      <span className="review-wave">Wave {session.wave}</span>
      <span>{counts.length ? "Tokens · " + counts.join(" / ") : "Tokens unreported"}</span>
      <span title={[session.startedAt && "Started " + absoluteTime(session.startedAt), session.finishedAt && "Finished " + absoluteTime(session.finishedAt)].filter(Boolean).join(" · ")}>
        {duration != null ? `Elapsed ${duration}` : session.startedAt ? "Started " + absoluteTime(session.startedAt) : "Time unreported"}
      </span>
    </div>
    <button className="btn btn-sm" onClick={onClose} data-autofocus>Close</button>
  </>}>
    {error && <div role="alert" className="inline-banner tone-warn">{error} <button className="btn btn-sm" onClick={onRetry}>Retry</button></div>}
    <div className="review-session-log" role="log" aria-label="Reviewer activity" aria-live="polite" tabIndex={0}
      ref={log} onScroll={e => { const node = e.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 16; }}>
      {session.truncated && <p className="review-detail-muted">Showing recent activity.</p>}
      {events.length ? <ol>{events.map((event, index) => <li key={index}>
        {event.at && <time dateTime={event.at} title={absoluteTime(event.at)}>{new Date(event.at).toLocaleTimeString()}</time>}
        <span>{event.label}</span>
      </li>)}</ol> : <p className="review-detail-muted">{error ? "Activity unavailable." : loading ? "Loading activity…" : "No activity recorded."}</p>}
    </div>
  </Dialog>, document.body);
}

export function ReviewSessions({ run, loadAttempt, onAccessLost }: {
  run: DeskRun; loadAttempt: LoadReviewAttempt; onAccessLost?: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeskRun>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const active = runActive(run);
  // Historical summaries may predate the reviewer ledger. Read the exact attempt when it is expanded.
  const fetchDetail = selected !== null || (open && !run.reviewerProgress?.sessions.length);
  useEffect(() => {
    if (!fetchDetail) return;
    let live = true, busy = false;
    async function read() {
      if (busy) return;
      busy = true;
      try {
        const current = await loadAttempt(run.id);
        if (!live) return;
        if (!current) throw new Error("Review attempt unavailable.");
        setDetail(current);
        setError("");
      } catch (cause) {
        if (!live) return;
        const message = errMessage(cause);
        setError(message);
        if (/^(access|configuration):/i.test(message)) {
          setDetail(undefined);
          setSelected(null);
          onAccessLost?.(message);
        }
      } finally {
        busy = false;
        if (live) setLoading(false);
      }
    }
    setLoading(true);
    void read();
    const visibleRead = () => { if (!document.hidden) void read(); };
    const timer = active ? window.setInterval(visibleRead, 3000) : undefined;
    if (active) window.addEventListener("focus", visibleRead);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener("focus", visibleRead); };
  }, [fetchDetail, selected, active, run.id, loadAttempt, onAccessLost, attempt]);

  const sessions = run.reviewerProgress?.sessions.length ? run.reviewerProgress.sessions : detail?.reviewerProgress?.sessions ?? [];
  const session = detail?.reviewerProgress?.sessions.find(s => s.id === selected) ?? sessions.find(s => s.id === selected);
  const attempts = new Map<string, number>();
  return <>
    <details className="review-sessions" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>Reviewer sessions{sessions.length > 0 && <span className="review-usage-total">{sessions.length}</span>}</summary>
      {sessions.length > 0 ? <div className="review-session-list">
        {sessions.map(item => {
          const group = JSON.stringify([item.wave, item.reviewer]);
          const ordinal = (attempts.get(group) ?? 0) + 1;
          attempts.set(group, ordinal);
          const retry = ordinal > 1 ? ` · Attempt ${ordinal}` : "";
          return <button key={item.id} className="review-session-row" aria-haspopup="dialog" disabled={item.state === "planned"}
            aria-label={`Open ${item.reviewer} session, wave ${item.wave}${retry}`} onClick={() => { setError(""); setSelected(item.id); }}>
            <span>{item.reviewer}{retry}</span><span className="review-wave">Wave {item.wave}</span>
            <span className="review-session-status" data-state={item.state}>{status[item.state]}</span>
            {item.state !== "planned" && <Icon name="chevronRight" size={14} />}
          </button>;
        })}
      </div> : <p className="review-detail-muted">{error ? "Reviewer details unavailable." : loading ? "Loading reviewers…" : "No reviewer sessions recorded."}</p>}
      {!selected && error && <p role="alert" className="inline-banner tone-warn">{error} <button className="btn btn-sm" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>}
    </details>
    {session && <ReviewerDialog session={session} active={active} error={error} loading={loading}
      onClose={() => setSelected(null)} onRetry={() => setAttempt(n => n + 1)} />}
  </>;
}
