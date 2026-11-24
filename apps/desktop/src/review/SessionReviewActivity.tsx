import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { canContinueDeskRun, type CoordinatorEvent, type DeskQuestion, type DeskRun } from "../../../../src/review/desk-run-types";
import { errMessage } from "../lib/format";
import { Icon } from "../components/Icon";
import { publishSessionReview, reviewRun, type ReviewRunAction } from "../platform/reviewRuns";
import { pendingManualQuestions, ReviewProgress, runStatusLabel } from "./ReviewProgress";
import { ReviewRunDialog } from "./ReviewRunDialog";
import { AgentMessage } from "../session/Transcript";
import { UserMessage } from "../session/UserMessage";
import { ReviewTranscript } from "./ReviewTranscript";
import { ReviewOutcome } from "./ReviewOutcome";
import { readRunStatus } from "./runPolling";
import { runActive } from "./useReviewRuns";
import type { ReviewComposerTarget, SessionReviewLink } from "./sessionReview";
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

export function SessionReviewActivity({ cwd, links, visible, onContinuation, onComposerTarget, focusComposer }: {
  cwd: string; links: readonly SessionReviewLink[]; visible: boolean;
  onContinuation: (link: SessionReviewLink) => void;
  onComposerTarget: (target: ReviewComposerTarget | undefined) => void;
  focusComposer: () => void;
}) {
  const [limit, setLimit] = useState(5);
  return <section className="session-review-activity" aria-label="Review activity">
    {links.length > limit && <button className="btn btn-sm" onClick={() => setLimit(value => value + 5)}>Show earlier reviews</button>}
    {links.slice(0, limit).map((link, index) => <FollowedReview cwd={cwd} link={link} visible={visible} key={link.id}
      canContinue={!links.slice(0, index).some(next => next.key.repositoryId === link.key.repositoryId && next.key.number === link.key.number &&
        next.key.viewer.toLowerCase() === link.key.viewer.toLowerCase() && next.revision.headSha === link.revision.headSha && next.revision.baseSha === link.revision.baseSha)}
      onContinuation={onContinuation} onComposerTarget={index === 0 ? onComposerTarget : undefined} focusComposer={focusComposer} />).reverse()}
  </section>;
}

function FollowedReview({ cwd, link, visible, canContinue, onContinuation, onComposerTarget, focusComposer }: {
  cwd: string; link: SessionReviewLink; visible: boolean; canContinue: boolean;
  onContinuation: (link: SessionReviewLink) => void;
  onComposerTarget?: ((target: ReviewComposerTarget | undefined) => void) | undefined;
  focusComposer: () => void;
}) {
  const [run, setRun] = useState<DeskRun | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [selectedQuestion, setSelectedQuestion] = useState<string>();
  const [sent, setSent] = useState<CoordinatorEvent[]>([]);
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

  const mutate = useCallback(async (action: Extract<ReviewRunAction, { kind: "cancel" | "answer" }>, question?: DeskQuestion) => {
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
        if (action.kind === "answer" && question) {
          const text = question.options.find(option => option.id === action.answer)?.label ?? action.answer;
          setSent(previous => [...previous, { kind: "answer", questionId: question.id, text,
            ...(question.reviewer && { reviewer: question.reviewer }) }]);
        }
      }
    }
    catch (failure) {
      if (current !== generation.current) return false;
      const message = errMessage(failure);
      if (/^access:/i.test(message)) {
        setRun(null);
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
  const replyTo = questions.find(question => question.allowFreeform && question.id === selectedQuestion)
    ?? questions.find(question => question.allowFreeform);
  const awaitAnswer = questions.length > 0;
  const terminal = !!run && !runActive(run);
  const needsPublication = run?.publication === "pending";
  const canResume = !!run && canContinue && canContinueDeskRun(run);
  const waitingForChoice = awaitAnswer && !replyTo;
  const sessionLabel = needsPublication ? "Review publication" : terminal ? "View review result" : "Review details";

  useLayoutEffect(() => {
    if (!onComposerTarget || !visible || (terminal && !canResume)) return;
    const scope = replyTo ? replyTo.id : canResume ? "continue" : "waiting";
    onComposerTarget({
      sessionId: link.sessionId, draftKey: `review:${link.id}:${scope}`,
      placeholder: replyTo ? `Reply to ${replyTo.reviewer ?? "the review orchestrator"}`
        : canResume ? "Give the orchestrator context and continue the review" : "Message the review orchestrator",
      ...(waitingForChoice && { disabledReason: "Choose a reply to the orchestrator’s question above." }),
      ...(!replyTo && !canResume && !waitingForChoice && { disabledReason: "Waiting for the review orchestrator." }),
      send: text => {
        if (!text.trim() || text.length > 2000) {
          setError("Enter a review reply of up to 2,000 characters.");
          return Promise.resolve(false);
        }
        return replyTo ? mutate({ kind: "answer", id: link.id, questionId: replyTo.id, answer: text.trim() }, replyTo)
          : canResume ? continueReview(text) : Promise.resolve(false);
      },
    });
    return () => onComposerTarget(undefined);
  }, [onComposerTarget, visible, terminal, canResume, replyTo, waitingForChoice, link, mutate, continueReview]);

  const events = run?.coordinatorActivity ?? [];
  const conversation = events.filter(event => event.kind === "message" || event.kind === "answer" ||
    (event.kind === "question" && !questions.some(question => event.questionId
      ? event.questionId === question.id : event.text === question.question && event.reviewer === question.reviewer)));
  const unloggedReplies = sent.filter(reply => !events.some(event => event.kind === "answer" &&
    (event.questionId ? event.questionId === reply.questionId : event.text === reply.text && event.reviewer === reply.reviewer)));

  return <>
    <UserMessage message={link.prompt || `Review https://github.com/${link.key.repo}/pull/${link.key.number}`} />
    <article className="session-review-item">
      <header>
        <strong role="status">{prefix} {status}</strong>
        {(needsPublication || canResume || awaitAnswer) && <span className="badge review-publication-pending">Action required</span>}
        {run && <div className="review-action-row">
          <button className="btn review-icon-action" type="button" aria-label={sessionLabel} title={sessionLabel}
            aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name={terminal ? "file" : "chat"} /></button>
        </div>}
      </header>
      {error && <div className="session-review-message" role="alert">{prefix} {error} <button className="btn btn-sm" onClick={() => void refresh()}>Retry status</button></div>}
      {run && <>
        {run.options?.orchestrator !== false && <ReviewProgress state={run.state} progress={run.reviewerProgress} />}
        {terminal && <ReviewOutcome run={run} />}
        {needsPublication && <p className="session-review-message">Choose whether to publish on GitHub.</p>}
        {awaitAnswer && <p className="session-review-message">{questions.length} {questions.length === 1 ? "question is" : "questions are"} waiting for a reply.</p>}
        {canResume && <button type="button" className="btn btn-sm" disabled={working}
          onClick={() => void continueReview("")}>Continue review</button>}
        {!terminal && !awaitAnswer && (run.reason || run.phase) && <p className="session-review-message">{run.reason || run.phase}</p>}
        {!!events.length && <details>
          <summary>Review activity</summary>
          <ReviewTranscript actor="Coordinator" events={events} loading={false} error={error} />
        </details>}
      </>}
    </article>
    {[...conversation, ...unloggedReplies].map((event, index) => event.kind === "answer"
      ? <UserMessage key={event.questionId ? `answer-${event.questionId}` : index} message={event.text} />
      : <AgentMessage key={event.questionId ? `question-${event.questionId}` : index}
        label={event.reviewer ?? "Review orchestrator"} text={event.text} />)}
    {questions.map(question => <AgentMessage key={question.id} label={question.reviewer ?? "Review orchestrator"} text={question.question}>
      <div className="review-reply-actions" role="group" aria-label={`Respond to ${question.reviewer ?? "the review orchestrator"}`}>
        {question.allowFreeform && onComposerTarget && <button className="btn btn-sm" type="button" disabled={working}
          aria-pressed={replyTo?.id === question.id} onClick={() => { setSelectedQuestion(question.id); focusComposer(); }}>
          {replyTo?.id === question.id ? "Replying in message field" : "Reply in message field"}
        </button>}
        {question.options.map(option => <button className="btn btn-sm" type="button" key={option.id} disabled={working}
          title={option.description} onClick={() => void mutate({ kind: "answer", id: link.id, questionId: question.id, answer: option.id }, question)}>
          {option.label}
        </button>)}
      </div>
    </AgentMessage>)}
    {visible && open && run && <ReviewRunDialog run={run} card={{ number: link.key.number, ...link.revision }}
      publication={sessionReviewPublication(cwd, link.key)}
      working={working} activity={{ follow: PASSIVE_FOLLOW, loaded: run.id, error }}
      error={error} onClose={() => setOpen(false)} onRefresh={() => void refresh()}
      loadAttempt={async id => {
        const result = await reviewRun(cwd, link.key, { kind: "status", id });
        return result.runs.find(item => item.id === id);
      }}
      onAccessLost={message => { setRun(null); setOpen(false); setError(message); }}
      onLifecycle={lifecycle}
      onAnswer={(id, questionId, answer) => void mutate({ kind: "answer", id, questionId, answer }, questions.find(question => question.id === questionId))}
      onCancel={id => void mutate({ kind: "cancel", id })} />}
  </>;
}
