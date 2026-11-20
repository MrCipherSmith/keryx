import { useCallback, useEffect, useRef, useState } from "react";
import type { DeskRun } from "../../../../src/review/desk-run-types";
import { errMessage } from "../lib/format";
import { Icon } from "../components/Icon";
import { publishSessionReview, reviewRun, type ReviewRunAction } from "../platform/reviewRuns";
import { pendingManualQuestions, ReviewProgress, runStatusLabel } from "./ReviewProgress";
import { ReviewRunDialog } from "./ReviewRunDialog";
import { ReviewTranscript } from "./ReviewTranscript";
import { ReviewOutcome } from "./ReviewOutcome";
import { readRunStatus } from "./runPolling";
import { runActive } from "./useReviewRuns";
import type { SessionReviewLink } from "./sessionReview";
import type { ReviewLifecycleCommand } from "./ReviewLifecycle";
import "./ReviewDetail.css";
import "./SessionReviewActivity.css";

const PASSIVE_FOLLOW = () => () => {};

export function SessionReviewActivity({ cwd, links, visible }: {
  cwd: string; links: readonly SessionReviewLink[]; visible: boolean;
}) {
  const [limit, setLimit] = useState(5);
  return <section className="session-review-activity" aria-label="Review activity">
    {links.length > limit && <button className="btn btn-sm" onClick={() => setLimit(value => value + 5)}>Show earlier reviews</button>}
    {links.slice(0, limit).reverse().map(link => <FollowedReview cwd={cwd} link={link} visible={visible} key={link.id} />)}
  </section>;
}

function FollowedReview({ cwd, link, visible }: { cwd: string; link: SessionReviewLink; visible: boolean }) {
  const [run, setRun] = useState<DeskRun | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
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
      setError(found ? "" : "This review attempt is no longer available.");
      if (!found) setOpen(false);
    } catch (failure) {
      if (current !== generation.current) return;
      const message = errMessage(failure);
      if (/^(access|configuration):/i.test(message)) {
        setRun(null);
        setOpen(false);
      }
      setError(message);
    } finally { inFlight.current = false; }
  }, [cwd, link]);
  const pending = !run || runActive(run);
  useEffect(() => {
    if (!visible) return;
    if (!pending) return;
    void refresh();
    const poll = () => {
      if (document.visibilityState !== "hidden") void refresh(true);
    };
    const timer = window.setInterval(poll, 6000);
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [visible, pending, refresh]);

  async function mutate(action: Extract<ReviewRunAction, { kind: "cancel" | "answer" }>) {
    if (writing.current) return;
    writing.current = true;
    const current = ++generation.current;
    setWorking(true);
    setError("");
    try {
      const result = await reviewRun(cwd, link.key, action);
      const latest = result.runs.find(item => item.id === link.id);
      if (current === generation.current && latest) {
        setRun(previous => ({ ...latest, coordinatorActivity: latest.coordinatorActivity ?? previous?.coordinatorActivity }));
      }
    }
    catch (failure) {
      if (current !== generation.current) return;
      const message = errMessage(failure);
      if (/^access:/i.test(message)) {
        setRun(null);
        setOpen(false);
      }
      setError(message);
      return;
    } finally { writing.current = false; setWorking(false); }
    await refresh();
  }
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
  const awaitAnswer = run && pendingManualQuestions(run).length > 0;
  const terminal = !!run && !runActive(run);
  const sessionLabel = awaitAnswer ? "Answer review question" : terminal ? "View review result" : "Open review session";
  const latest = run?.coordinatorActivity?.filter(item => item.kind === "status" || item.kind === "message" || item.kind === "error").at(-1);
  return <>
  {typeof link.prompt === "string" && link.prompt && <p className="session-review-prompt" aria-label="Your review request">{link.prompt}</p>}
  <article className="session-review-item">
    <header>
      <strong role="status">{prefix} {status}</strong>
      {run && <div className="review-action-row">
        <button className="btn review-icon-action" type="button" aria-label={sessionLabel} title={sessionLabel}
          aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name={terminal ? "file" : "chat"} /></button>
      </div>}
    </header>
    {error && <div className="session-review-message" role="alert">{prefix} {error} <button className="btn btn-sm" onClick={() => void refresh()}>Retry status</button></div>}
    {run && <>
      <ReviewProgress state={run.state} progress={run.reviewerProgress} />
      {terminal && <ReviewOutcome run={run} />}
      {latest && run.state !== "completed" && <p className="session-review-message">{prefix} {latest.text}</p>}
      {!terminal && !latest && (run.reason || run.phase) && <p className="session-review-message">{prefix} {run.reason || run.phase}</p>}
      {!!run.coordinatorActivity?.length && <details>
        <summary>Review activity</summary>
        <ReviewTranscript actor="Coordinator" events={run.coordinatorActivity.map(item => ({ ...item, text: `${prefix} ${item.text}` }))}
          loading={false} error={error} />
      </details>}
    </>}
    {visible && open && run && <ReviewRunDialog run={run} card={{ number: link.key.number, ...link.revision }}
      working={working} activity={{ follow: PASSIVE_FOLLOW, loaded: run.id, error }}
      error={error} onClose={() => setOpen(false)} onRefresh={() => void refresh()}
      loadAttempt={async id => {
        const result = await reviewRun(cwd, link.key, { kind: "status", id });
        return result.runs.find(item => item.id === id);
      }}
      onAccessLost={message => { setRun(null); setOpen(false); setError(message); }}
      onLifecycle={lifecycle}
      onAnswer={(id, questionId, answer) => void mutate({ kind: "answer", id, questionId, answer })}
      onCancel={id => void mutate({ kind: "cancel", id })} />}
  </article></>;
}
