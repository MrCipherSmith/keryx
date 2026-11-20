import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DeskQuestion, DeskReviewerSession, DeskRun } from "../../../../src/review/desk-run-types";
import { Dialog } from "../components/ui";
import { Icon } from "../components/Icon";
import { absoluteTime, errMessage } from "../lib/format";
import { runActive } from "./useReviewRuns";
import { ReviewTranscript, SessionOutcome } from "./ReviewTranscript";
import { ReviewQuestion, type AnswerReviewQuestion } from "./ReviewQuestion";
import { pendingManualQuestions } from "./ReviewProgress";

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

type Reviewer = Omit<DeskReviewerSession, "wave"> & { wave?: number };
export function sessionForQuestion(question: DeskQuestion, sessions: Reviewer[]): Reviewer {
  const id = question.reviewerSessionId!;
  return sessions.find(session => session.id === id) ?? {
    id, reviewer: question.reviewer || "Reviewer", wave: question.wave, state: "unknown",
  };
}

function reviewerStatus(session: Reviewer, waiting: boolean) {
  if (waiting) return "Action required";
  return session.needsContext ? status[session.state] + " · Needs context" : status[session.state];
}

export function ReviewerDialog({ run, session, error, loading, working, onAnswer, onClose, onRetry, onCoordinator }: {
  run: DeskRun; session: Reviewer; error: string; loading: boolean; working: boolean; onAnswer: AnswerReviewQuestion;
  onClose: () => void; onRetry: () => void; onCoordinator?: () => void;
}) {
  const allQuestions = pendingManualQuestions(run);
  const questions = allQuestions.filter(item => item.reviewerSessionId === session.id);
  const coordinator = allQuestions.find(item => !item.reviewerSessionId);
  const forwardTo = !questions.length && session.needsContext && coordinator?.allowFreeform ? coordinator : undefined;
  const [forwardId, setForwardId] = useState<string>();
  const owner = session.reviewer + (session.wave != null ? " · Wave " + session.wave : "");
  const duration = elapsed(session.startedAt, session.finishedAt, runActive(run) && session.state === "running");
  const usage = session.usage;
  const counts = [
    usage?.inputTokens != null && `${usage.inputTokens.toLocaleString()} in`,
    usage?.outputTokens != null && `${usage.outputTokens.toLocaleString()} out`,
    usage?.totalTokens != null && `${usage.totalTokens.toLocaleString()} total`,
  ].filter(Boolean);
  return createPortal(<div className="review-session-overlay"><Dialog width={1120} onClose={onClose} title={<span className="review-session-heading">
    <span>{session.reviewer}</span><span className="review-session-status" data-state={questions.length ? "waiting" : session.state}>{reviewerStatus(session, questions.length > 0)}</span>
    <small title={session.id}>{[session.provider, session.model, `Session ${session.id.slice(0, 8)}`].filter(Boolean).join(" · ")}</small>
  </span>} footer={<>
    <div className="review-session-footer">
      {session.wave != null && <span className="review-wave">Wave {session.wave}</span>}
      <span>{counts.length ? (session.usagePartial ? "Partial tokens · " : "Tokens · ") + counts.join(" / ") : "Tokens unreported"}</span>
      <span title={[session.startedAt && "Started " + absoluteTime(session.startedAt), session.finishedAt && "Finished " + absoluteTime(session.finishedAt)].filter(Boolean).join(" · ")}>
        {duration != null ? `Elapsed ${duration}` : session.startedAt ? "Started " + absoluteTime(session.startedAt) : "Time unreported"}
      </span>
    </div>
    {onCoordinator && <button className="btn btn-sm" onClick={onCoordinator}>{allQuestions.length > 1 ? "All questions" : "Coordinator session"}</button>}
    <button className="btn btn-sm" onClick={onClose} data-autofocus>Close</button>
  </>}>
    {error && <div role="alert" className="inline-banner tone-warn">{error} <button className="btn btn-sm" onClick={onRetry}>Retry</button></div>}
    <div className="review-run-dialog">
      {session.needsContext && !questions.length && <p className="review-context-note">
        This reviewer finished with missing evidence. See the request for context in the result below.
      </p>}
      {questions.map(q => <ReviewQuestion key={q.id} question={q} legend={session.reviewer + " question"} working={working}
        onAnswer={answer => onAnswer(run.id, q.id, answer)} />)}
      {(session.finalOutput || session.outcomeReason || (!loading && !error && ["completed", "partial", "failed", "cancelled"].includes(session.state))) &&
        <SessionOutcome title="Reviewer result" state={session.state} reason={session.outcomeReason}
          result={session.finalOutput || (session.outcomeReason ? undefined : "No reviewer output recorded.")} />}
      {forwardTo && <section className="review-context-forward">
        {forwardId !== forwardTo.id ? <button className="btn btn-sm" onClick={() => setForwardId(forwardTo.id)}>Provide context to coordinator</button> : <>
          <h3>Context for the coordinator</h3>
          <p>{session.reviewer} has finished. Choose an option to answer the coordinator’s current question, or add context to the draft and send it to the coordinator.</p>
          <ReviewQuestion key={forwardTo.id} legend="Coordinator question" working={working} question={forwardTo}
            initialText={`[${owner}] `} onAnswer={answer => onAnswer(run.id, forwardTo.id, answer)} />
        </>}
      </section>}
      <ReviewTranscript actor="Reviewer" events={(session.activity ?? []).map(event =>
        ({ kind: event.kind ?? "status", text: event.label, at: event.at }))}
        error={error} loading={loading} truncated={session.truncated} />
    </div>
  </Dialog></div>, document.body);
}

export interface ActivitySubscription {
  follow: (id: string) => () => void;
  loaded: string | undefined;
  error: string;
}

export function ReviewSessions({ run, loadAttempt, onAccessLost, activity, onAnswer, working, answerError }: {
  onAnswer: AnswerReviewQuestion; working: boolean; answerError: string;
  activity: ActivitySubscription;
  run: DeskRun; loadAttempt: LoadReviewAttempt; onAccessLost?: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeskRun>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const questions = pendingManualQuestions(run);
  // Historical summaries may predate the reviewer ledger. Read the exact attempt when it is expanded.
  const fetchDetail = open && !selected && !run.reviewerProgress?.sessions.length;
  // The drawer owns the single live poll. Include this attempt’s activity in its history response.
  useEffect(() => {
    if (selected) return activity.follow(run.id);
  }, [activity.follow, selected, run.id, attempt]);
  useEffect(() => {
    if (!fetchDetail) return;
    let live = true;
    async function read() {
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
        if (live) setLoading(false);
      }
    }
    setLoading(true);
    void read();
    return () => { live = false; };
  }, [fetchDetail, run.id, loadAttempt, onAccessLost, attempt]);

  const sessions: Reviewer[] = [...(run.reviewerProgress?.sessions.length ? run.reviewerProgress.sessions : detail?.reviewerProgress?.sessions ?? [])];
  for (const q of questions) {
    if (q.reviewerSessionId && !sessions.some(item => item.id === q.reviewerSessionId)) sessions.push(sessionForQuestion(q, sessions));
  }
  const session = sessions.find(s => s.id === selected);
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
          const waiting = questions.some(q => q.reviewerSessionId === item.id);
          const disabled = item.state === "planned" && !waiting;
          const label = reviewerStatus(item, waiting);
          const wave = item.wave != null ? ", wave " + item.wave : "";
          return <button key={item.id} className="review-session-row" aria-haspopup="dialog" disabled={disabled}
            aria-label={`${disabled ? "" : "Open "}${item.reviewer} session${wave}${retry}, ${label}`} onClick={() => { setError(""); setSelected(item.id); }}>
            <span>{item.reviewer}{retry}</span>{item.wave != null && <span className="review-wave">Wave {item.wave}</span>}
            <span className="review-session-status" data-state={waiting ? "waiting" : item.state}>{label}</span>
            {!disabled && <Icon name="chevronRight" size={14} />}
          </button>;
        })}
      </div> : <p className="review-detail-muted">{error ? "Reviewer details unavailable." : loading ? "Loading reviewers…" : "No reviewer sessions recorded."}</p>}
      {!selected && error && <p role="alert" className="inline-banner tone-warn">{error} <button className="btn btn-sm" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>}
    </details>
    {session && <ReviewerDialog key={session.id} run={run} session={session} working={working} onAnswer={onAnswer} error={answerError || activity.error} loading={activity.loaded !== run.id}
      onClose={() => setSelected(null)} onRetry={() => setAttempt(n => n + 1)} />}
  </>;
}
