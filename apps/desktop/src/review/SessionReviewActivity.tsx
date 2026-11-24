import { useCallback, useEffect, useRef, useState } from "react";
import { canContinueDeskRun, type CoordinatorEvent, type DeskRun } from "../../../../src/review/desk-run-types";
import { errMessage } from "../lib/format";
import { Icon } from "../components/Icon";
import { publishSessionReview, reviewRun, type ReviewRunAction } from "../platform/reviewRuns";
import { pendingManualQuestions, ReviewProgress, runStatusLabel } from "./ReviewProgress";
import { ReviewRunDialog } from "./ReviewRunDialog";
import { ReviewQuestion } from "./ReviewQuestion";
import { ReviewTranscript } from "./ReviewTranscript";
import { ReviewPlanSummary, reviewPlanEvidence } from "./ReviewPlanSummary";
import { ReviewOutcome } from "./ReviewOutcome";
import { readRunStatus } from "./runPolling";
import { runActive } from "./useReviewRuns";
import type { SessionReviewLink } from "./sessionReview";
import type { ReviewLifecycleCommand } from "./ReviewLifecycle";
import "./ReviewDetail.css";
import "./SessionReviewActivity.css";

const PASSIVE_FOLLOW = () => () => {};

/**
 * Publication from Sessions offers no "Update review": this view follows one attempt on its recorded range and
 * cannot see the PR's other attempts, so the next round starts from the Review panel.
 */
export function sessionReviewPublication(cwd: string, key: SessionReviewLink["key"]) {
  return { cwd, target: key, url: `https://github.com/${key.repo}/pull/${key.number}` };
}

export function SessionReviewActivity({ cwd, links, visible, onContinuation }: {
  cwd: string; links: readonly SessionReviewLink[]; visible: boolean;
  onContinuation: (link: SessionReviewLink) => void;
}) {
  const [limit, setLimit] = useState(5);
  return <section className="session-review-activity" aria-label="Review activity">
    {links.length > limit && <button className="btn btn-sm" onClick={() => setLimit(value => value + 5)}>Show earlier reviews</button>}
    {links.slice(0, limit).map((link, index) => <FollowedReview cwd={cwd} link={link} visible={visible} key={link.id}
      canContinue={!links.slice(0, index).some(next => next.key.repositoryId === link.key.repositoryId && next.key.number === link.key.number &&
        next.key.viewer.toLowerCase() === link.key.viewer.toLowerCase() && next.revision.headSha === link.revision.headSha && next.revision.baseSha === link.revision.baseSha)}
      onContinuation={onContinuation} />).reverse()}
  </section>;
}

function FollowedReview({ cwd, link, visible, canContinue, onContinuation }: {
  cwd: string; link: SessionReviewLink; visible: boolean; canContinue: boolean;
  onContinuation: (link: SessionReviewLink) => void;
}) {
  const [run, setRun] = useState<DeskRun | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [history, setHistory] = useState<{ events: CoordinatorEvent[]; before?: number }>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const readingEarlier = useRef(false);
  const inFlight = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const publishedState = useRef<string>();
  useEffect(() => () => { generation.current++; }, [cwd, link]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  const refresh = useCallback(async (automatic = false) => {
    if (inFlight.current || writing.current) return;
    const current = generation.current;
    inFlight.current = true;
    try {
      const snapshot = await readRunStatus(reviewRun, cwd, link.key, { kind: "status", activityId: link.id }, automatic);
      if (!snapshot || current !== generation.current) return;
      const found = snapshot.runs.find(item => item.id === link.id);
      setRun(found ?? null);
      if (!found) setHistory(undefined);
      if (found?.source === "session" && publishedState.current !== found.state) {
        publishedState.current = found.state;
        publishSessionReview(cwd, link.key, snapshot);
      }
      setError(found ? "" : "This review attempt is no longer available.");
      if (!found) setOpen(false);
    } catch (failure) {
      if (current !== generation.current) return;
      const message = errMessage(failure);
      if (/^(access|configuration):/i.test(message)) {
        setRun(null);
        setHistory(undefined);
        setOpen(false);
      }
      setError(message);
    } finally { inFlight.current = false; }
  }, [cwd, link]);
  const pending = !run || runActive(run);
  const automaticPublication = run?.options?.autoPublish && run.publication === "pending" ? run.finishedAt : null;
  useEffect(() => {
    if (!visible) return;
    if (pending) void refresh();
    const poll = () => {
      if (document.visibilityState !== "hidden") void refresh(true);
    };
    const timer = pending || automaticPublication ? window.setInterval(() => {
      if (pending || (automaticPublication && Date.now() - Date.parse(automaticPublication) < 120_000)) poll();
    }, 6000) : undefined;
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [visible, pending, automaticPublication, refresh]);

  const mutate = useCallback(async (action: Extract<ReviewRunAction, { kind: "cancel" | "answer" }>) => {
    if (writing.current) return false;
    writing.current = true;
    const current = ++generation.current;
    setWorking(true);
    setError("");
    try {
      const result = await reviewRun(cwd, link.key, action);
      const latest = result.runs.find(item => item.id === link.id);
      if (action.kind === "answer" && (!latest || pendingManualQuestions(latest).some(item => item.id === action.questionId))) {
        throw new Error("Could not confirm the reply. Refresh review status before retrying.");
      }
      if (current === generation.current && latest) {
        setRun(previous => ({ ...latest, coordinatorActivity: latest.coordinatorActivity ?? previous?.coordinatorActivity }));
      }
    }
    catch (failure) {
      if (current !== generation.current) return false;
      const message = errMessage(failure);
      if (/^access:/i.test(message)) {
        setRun(null);
        setHistory(undefined);
        setOpen(false);
      }
      setError(message);
      if (/^stale:/i.test(message)) window.setTimeout(() => void refresh(), 0);
      return false;
    } finally { writing.current = false; setWorking(false); }
    void refresh();
    return true;
  }, [cwd, link, refresh]);
  const continueReview = useCallback(async (guidance: string) => {
    if (writing.current) return false;
    writing.current = true;
    const current = ++generation.current;
    setWorking(true);
    setError("");
    try {
      const note = guidance.trim();
      const result = await reviewRun(cwd, link.key, { kind: "continue", id: link.id, ...(note && { guidance: note }) });
      const next = result.runs.find(item => item.id === result.startedRunId);
      if (!next || next.continuation?.previousId !== link.id)
        throw new Error("Could not confirm the continuation. Refresh the review before trying again.");
      onContinuation({ ...link, id: next.id, prompt: note || "Continue review" });
      publishSessionReview(cwd, link.key, result);
      return true;
    } catch (failure) {
      if (current === generation.current) setError(errMessage(failure));
      return false;
    } finally {
      writing.current = false;
      setWorking(false);
    }
  }, [cwd, link, onContinuation]);

  const lifecycle = useCallback<ReviewLifecycleCommand>(async action => {
    const snapshot = await reviewRun(cwd, link.key, action);
    if (action.kind === "decide") {
      generation.current++;
      const attempt = snapshot.runs.find(item => item.id === link.id);
      setRun(attempt ?? null);
      if (!attempt) setOpen(false);
      publishSessionReview(cwd, link.key, snapshot);
    }
    return snapshot;
  }, [cwd, link]);

  const prefix = `[Review #${link.key.number}]`;
  const status = run ? runStatusLabel(run) : "Checking review status…";
  const questions = run ? pendingManualQuestions(run) : [];
  const awaitAnswer = questions.length > 0;
  const terminal = !!run && !runActive(run);
  const needsPublication = run?.publication === "pending";
  const canResume = !!run && canContinue && canContinueDeskRun(run);
  const sessionLabel = needsPublication ? "Review publication" : terminal ? "View review result" : "Review details";
  const events = history?.events ?? run?.coordinatorActivity ?? [];
  const before = history ? history.before : run?.coordinatorActivityBefore;
  async function loadEarlier() {
    if (before === undefined || readingEarlier.current) return;
    readingEarlier.current = true;
    const current = generation.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const snapshot = await reviewRun(cwd, link.key, { kind: "status", activityId: link.id, activityBefore: before });
      if (current !== generation.current) return;
      const page = snapshot.runs.find(item => item.id === link.id);
      if (!page?.coordinatorActivity || (page.coordinatorActivityBefore !== undefined && page.coordinatorActivityBefore >= before)) {
        throw new Error("The review activity could not be loaded.");
      }
      const previous = page.coordinatorActivity;
      const boundary = previous.at(-1);
      const newer = events[0];
      const duplicate = boundary?.kind === "message" && newer?.kind === "message" && boundary.text === newer.text;
      setHistory({ events: [...(duplicate ? previous.slice(0, -1) : previous), ...events],
        ...(page.coordinatorActivityBefore !== undefined && { before: page.coordinatorActivityBefore }) });
    } catch (error) {
      if (current !== generation.current) return;
      const message = errMessage(error);
      if (/^(access|configuration):/i.test(message)) {
        setRun(null);
        setHistory(undefined);
        setOpen(false);
        setError(message);
      } else {
        setHistoryError(message);
      }
    } finally {
      readingEarlier.current = false;
      setHistoryLoading(false);
    }
  }

  return <>
    <article className="session-review-item">
      <header>
        <strong role="status">{prefix} {status}</strong>
        {(needsPublication || canResume || awaitAnswer) && <span className="badge review-publication-pending">Action required</span>}
        {run && <div className="review-action-row">
          <button className="btn review-icon-action" type="button" aria-label={sessionLabel} title={sessionLabel}
            aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name={terminal ? "file" : "chat"} /></button>
        </div>}
      </header>
      {link.prompt && <blockquote className="session-review-request">{link.prompt}</blockquote>}
      {error && <div className="session-review-message" role="alert">{prefix} {error} <button className="btn btn-sm" onClick={() => void refresh()}>Retry status</button></div>}
      {run && <>
        <ReviewPlanSummary data={{
          title: run.pullRequestTitle ?? `${link.key.repo} #${link.key.number}`,
          headSha: run.headSha,
          ...reviewPlanEvidence(run.reviewerProgress?.planSummary, run.pullRequestScope),
          ...(run.options?.orchestrator === false && { singleReviewer: true }),
          stage: run.phase,
          runState: run.state,
          ...(run.reviewerProgress && { assignmentProgress: run.reviewerProgress }),
          ...(needsPublication ? { operatorStep: "Choose whether to publish on GitHub." }
            : awaitAnswer ? { operatorStep: run.reason || "Reply to the requested review context." } : {}),
        }} />
        {run.options?.orchestrator !== false && <ReviewProgress state={run.state} progress={run.reviewerProgress} />}
        {terminal && <ReviewOutcome run={run} />}
        {awaitAnswer && <p className="session-review-message">{questions.length} {questions.length === 1 ? "question is" : "questions are"} waiting for a reply.</p>}
        {canResume && <form className="review-question" onSubmit={event => {
          event.preventDefault();
          void continueReview(guidance);
        }}>
          <label>Context for the coordinator<textarea maxLength={2000} value={guidance}
            onChange={event => setGuidance(event.target.value)} rows={2} /></label>
          <button type="submit" className="btn btn-sm" disabled={working}>Continue review</button>
        </form>}
        {(events.length > 0 || before !== undefined) && <details>
          <summary>Review activity</summary>
          {before !== undefined && <button className="btn btn-sm" type="button" disabled={historyLoading} onClick={() => void loadEarlier()}>
            {historyLoading ? "Loading activity…" : "Load earlier activity"}
          </button>}
          {history && <button className="btn btn-sm" type="button" disabled={historyLoading} onClick={() => {
            setHistory(undefined);
            setHistoryError("");
          }}>Back to latest activity</button>}
          {historyError && <p role="alert">{historyError}</p>}
          <ReviewTranscript actor="Coordinator" events={events} loading={false} error={error} followLatest={!history} />
        </details>}
      </>}
    </article>
    {questions.map(question => <ReviewQuestion key={question.id} question={question} working={working}
      legend={question.reviewer ?? "Review coordinator"}
      onAnswer={answer => void mutate({ kind: "answer", id: link.id, questionId: question.id, answer })} />)}
    {visible && open && run && <ReviewRunDialog run={run} card={{ number: link.key.number, ...link.revision }}
      publication={sessionReviewPublication(cwd, link.key)}
      working={working} activity={{ follow: PASSIVE_FOLLOW, loaded: run.id, error }}
      error={error} onClose={() => setOpen(false)} onRefresh={() => void refresh()}
      loadAttempt={async id => {
        const result = await reviewRun(cwd, link.key, { kind: "status", id });
        return result.runs.find(item => item.id === id);
      }}
      onAccessLost={message => { setRun(null); setHistory(undefined); setOpen(false); setError(message); }}
      onLifecycle={lifecycle}
      onAnswer={(id, questionId, answer) => void mutate({ kind: "answer", id, questionId, answer })}
      onCancel={id => void mutate({ kind: "cancel", id })} />}
  </>;
}
