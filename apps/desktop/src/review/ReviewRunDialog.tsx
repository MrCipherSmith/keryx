import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { hasDeskWorker, type DeskRun } from "../../../../src/review/desk-run-types";
import { SOURCE_LABEL } from "../reviews/model";
import { Icon } from "../components/Icon";
import { Menu } from "../components/Menu";
import { Dialog } from "../components/ui";
import { absoluteTime } from "../lib/format";
import { RunAttempt } from "./ReviewRuns";
import { pendingManualQuestions, runStatusLabel } from "./ReviewProgress";
import { ReviewTranscript } from "./ReviewTranscript";
import { ReviewOutcome } from "./ReviewOutcome";
import { runActive } from "./useReviewRuns";
import { ReviewerDialog, sessionForQuestion } from "./ReviewSessions";
import { ReviewQuestion } from "./ReviewQuestion";

export function ReviewRunHistory({ runs, onSelect }: { runs: DeskRun[]; onSelect: (id: string) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  function close() {
    setOpen(false);
    anchor.current?.focus();
  }
  return <div className="review-run-history">
    <button ref={anchor} className="btn btn-sm" aria-haspopup="menu" aria-expanded={open && !!runs.length}
      disabled={!runs.length} onClick={() => setOpen(value => !value)}>
      <Icon name="history" size={14} /> History{runs.length > 0 && <span>{runs.length}</span>}
    </button>
    {open && runs.length > 0 && createPortal(<div className="review-run-menu"><Menu anchor={anchor.current} label="Review run history" onClose={close}
      items={runs.map(run => ({
        id: run.id,
        label: runStatusLabel(run) + " · " + absoluteTime(run.createdAt),
        description: [SOURCE_LABEL[run.source],
          "Run " + run.id.slice(0, 8), run.headSha.slice(0, 9)].filter(Boolean).join(" · "),
        onSelect: () => onSelect(run.id),
      }))} /></div>, document.body)}
  </div>;
}

type Props = ComponentProps<typeof RunAttempt> & {
  onClose: () => void; error: string; onAnswer: (id: string, questionId: string, answer: string) => void;
  onRefresh: () => void;
  onOpenWorkspace?: () => Promise<void>;
};
export function ReviewRunDialog({ onClose, error, onAnswer, onRefresh, onOpenWorkspace, ...attempt }: Props) {
  const { run, card, activity, working } = attempt;
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  async function openWorkspace() {
    setOpeningWorkspace(true);
    setWorkspaceError("");
    try { await onOpenWorkspace?.(); }
    catch { setWorkspaceError("Could not open the review in Sessions."); }
    finally { setOpeningWorkspace(false); }
  }
  const hasCoordinator = hasDeskWorker(run);
  useEffect(() => {
    if (hasCoordinator) return activity.follow(run.id);
  }, [activity.follow, run.id, hasCoordinator]);
  const questions = pendingManualQuestions(run);
  const [chosen, setChosen] = useState(() => questions.length === 1 ? questions[0] : undefined);
  const reviewerQuestion = chosen?.reviewerSessionId ? chosen : undefined;
  const coordinator = questions.find(item => !item.reviewerSessionId);
  const visibleCoordinator = coordinator && (questions.length === 1 || chosen?.id === coordinator.id);
  if (reviewerQuestion) {
    const session = sessionForQuestion(reviewerQuestion, run.reviewerProgress?.sessions ?? []);
    return <ReviewerDialog key={session.id} run={run} session={session} working={working} onAnswer={onAnswer}
      loading={activity.loaded !== run.id} error={error || activity.error} onRetry={onRefresh}
      onClose={onClose} onCoordinator={() => setChosen(undefined)} />;
  }
  const terminal = !runActive(run);
  return createPortal(<div className="review-session-overlay"><Dialog icon="chat" width={1120} onClose={onClose}
    title={<span className="review-session-heading"><span>Review session · PR #{card.number}</span>
      <span className="review-session-status" data-state={run.state}>{runStatusLabel(run)}</span>
      <small>{hasCoordinator ? "Coordinator" : SOURCE_LABEL[run.source]} · Run {run.id.slice(0, 8)}</small></span>}
    footer={<><div className="review-session-footer">
      {run.reviewerProgress?.wave != null && <span className="review-wave">Wave {run.reviewerProgress.wave}</span>}
      {run.usage?.total.totalTokens != null && <span>{run.usage.total.totalTokens.toLocaleString()} tokens</span>}
      <time dateTime={run.createdAt}>{absoluteTime(run.createdAt)}</time>
    </div>{onOpenWorkspace && <button className="btn btn-sm btn-primary" onClick={() => void openWorkspace()}
      disabled={openingWorkspace}>Open in Sessions</button>}<button className="btn btn-sm" onClick={onClose} data-autofocus>Close</button></>}>
    <div className="review-run-dialog">
      {workspaceError && <p role="alert" className="inline-banner tone-warn">{workspaceError}</p>}
      {error && <p role="alert" className="inline-banner tone-warn">{error} <button className="btn btn-sm" onClick={onRefresh} disabled={working}>Refresh session</button></p>}
      {questions.length > 0 && !visibleCoordinator && <section className="review-question-chooser">
        <h3>Questions needing your answer</h3>
        {questions.map(item => <button key={item.id} className="btn review-answer-option" onClick={() => setChosen(item)}>
          <strong>{item.reviewerSessionId ? (item.reviewer || "Reviewer") + (item.wave != null ? " · Wave " + item.wave : "") : "Coordinator"}</strong>
          <span>{item.question}</span>
        </button>)}
      </section>}
      {visibleCoordinator && <div>
        {questions.length > 1 && <button className="btn btn-sm" onClick={() => setChosen(undefined)}>All questions</button>}
        <ReviewQuestion legend="Coordinator question" key={coordinator.id} question={coordinator} working={working}
          onAnswer={answer => onAnswer(run.id, coordinator.id, answer)} />
      </div>}
      {terminal && <ReviewOutcome run={run} />}
      {hasCoordinator && <ReviewTranscript actor="Coordinator" events={run.coordinatorActivity ?? []}
        loading={activity.loaded !== run.id} error={activity.error} />}
      <details className="review-session-details" open={!hasCoordinator || run.publication === "pending" || undefined}>
        <summary>Run details, reviewers and report</summary>
        <RunAttempt {...attempt} onPublicationDecision={onRefresh} onAnswer={onAnswer} answerError={error} showOutcome={false} />
      </details>
    </div>
  </Dialog></div>, document.body);
}
