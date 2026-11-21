import { useEffect, useState, type ReactNode } from "react";
import { DESK_RUN_SCOPE, type DeskRevision, type DeskRun, type DeskRunKey } from "../../../../src/review/desk-run-types";
import { Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { absoluteTime, errMessage } from "../lib/format";
import { DECISION_LABEL } from "./model";
import type { ReviewCard } from "./types";
import { runActive, sameRange } from "./useReviewRuns";
import { ReviewProgress, pendingManualQuestions, runStatusLabel, singleReviewerFinished, TranscriptUpdate } from "./ReviewProgress";
import { ReviewSessions, type LoadReviewAttempt, type ActivitySubscription } from "./ReviewSessions";
import type { AnswerReviewQuestion } from "./ReviewQuestion";
import { ReviewUsage } from "./ReviewUsage";
import { runLimits } from "./ReviewRuleInfo";
import { ReviewPublishDialog, type reviewPublish } from "./ReviewPublishDialog";
import { ReviewLifecycle, reviewIsArchived, type ReviewLifecycleCommand } from "./ReviewLifecycle";
import { ReviewOutcome } from "./ReviewOutcome";
import { ReviewReportMarkdown } from "./ReviewReportMarkdown";

function Range({ value }: { value: DeskRevision }) {
  if (!value.baseSha && !value.headSha) return <>Unrecorded</>;
  return <span className="mono" title={value.baseSha + " → " + value.headSha}>
    {value.baseSha.slice(0, 9) || "Unknown base"} → {value.headSha.slice(0, 9) || "Unknown head"}
  </span>;
}

export function launchAction(runs: DeskRun[], card: ReviewCard) {
  const matching = runs.filter(run => run.source !== "existing" && !reviewIsArchived(run) && sameRange(run, card));
  const same = matching.find(runActive) ?? matching[0];
  if (same && runActive(same)) {
    const questions = pendingManualQuestions(same);
    if (questions.length) {
      const label = questions.length > 1 ? "Answer questions" : questions[0]!.reviewerSessionId ? "Reply to reviewer" : "Reply to coordinator";
      return { open: true, label, sessionId: same.id };
    }
    return { open: true, label: "View active review", sessionId: same !== runs[0] ? same.id : undefined };
  }
  if (same?.state === "completed" && same.scope === DESK_RUN_SCOPE && same.result?.coverage === "complete" && sameRange(same.result?.reviewed ?? null, card)) return { open: true, label: "View review result", sessionId: same !== runs[0] ? same.id : undefined };
  return { open: false, label: same ? "Retry review" : runs.some(run => run.headSha && run.baseSha && !sameRange(run, card)) ? "Review changes" : "Start review" };
}

interface ReportProps {
  loadAttempt: LoadReviewAttempt;
  onAccessLost?: (reason: string) => void;
}

function ReviewReport({ run, loadAttempt, onAccessLost }: { run: DeskRun } & ReportProps) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const inline = run.result?.report;
  const deferred = run.result?.reportDeferred;
  useEffect(() => {
    if (!open || !deferred || inline || report !== null) return;
    let current = true;
    setError("");
    void loadAttempt(run.id).then(attempt => {
      if (current) setReport(attempt?.result?.report ?? "");
    }).catch(cause => {
      if (!current) return;
      const message = errMessage(cause);
      setError(message);
      if (/^access:/i.test(message)) onAccessLost?.(message);
    });
    return () => { current = false; };
  }, [open, deferred, inline, run.id, report, loadAttempt, attempt, onAccessLost]);
  if (!inline && !deferred) return null;
  return <details className="desk-run-report" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Open review report</summary>
    {error && <div role="alert" className="inline-banner tone-warn">{error} <button className="btn btn-sm"
      onClick={() => setAttempt(n => n + 1)}>Retry report</button></div>}
    {open && (inline || report) && <ReviewReportMarkdown text={inline || report || ""} label="Review report" />}
    {!inline && report === "" && <p>Report unavailable.</p>}
    {open && !error && !inline && report === null && <Spinner label="Loading report" />}
  </details>;
}

interface PublicationTarget {
  cwd: string;
  target: DeskRunKey;
  url: string;
  publishCommand?: typeof reviewPublish | undefined;
}

export function RunAttempt({ run, card, onCancel, working, loadAttempt, onAccessLost, activity, publication, onPublicationDecision, onOpenSession, children, onAnswer, onLifecycle, answerError = "", showOutcome = true }: ReportProps & {
  publication?: PublicationTarget;
  onPublicationDecision?: () => void;
  children?: ReactNode; onAnswer: AnswerReviewQuestion; answerError?: string;
  onLifecycle?: ReviewLifecycleCommand;
  onOpenSession?: (id: string) => void;
  showOutcome?: boolean;
  activity: ActivitySubscription; run: DeskRun; card: Pick<ReviewCard, "number" | "baseSha" | "headSha">; working: boolean; onCancel: (id: string) => void;
}) {
  const [publishOpen, setPublishOpen] = useState(false);
  const active = runActive(run);
  const questions = pendingManualQuestions(run);
  const question = questions[0];
  const result = run.result;
  const sessionLabel = question ? (questions.length > 1 ? "Answer review questions" : "Answer review question") : "Open review session";
  const stopLabel = run.state === "cancelling" ? "Stopping…" : "Stop review";
  const recorded = result?.reviewed ?? run;
  const historic = !!((recorded.headSha && recorded.headSha !== card.headSha) || (recorded.baseSha && recorded.baseSha !== card.baseSha));
  const draft = publication && run.source !== "existing" && (run.state === "completed" || run.state === "partial") &&
    result?.reviewed && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/i.test(publication.url) ? publication : undefined;
  const publicationPending = draft && !historic && run.publication === "pending";
  return <article className="desk-run" aria-label={'Review attempt ' + run.id}>
    <header className="desk-run-head">
      <div className="desk-run-state">
        <strong className={active && !question ? "review-live-state" : undefined}>{runStatusLabel(run)}</strong>
        {historic && <span className="badge">Earlier revision</span>}
        {publicationPending && <span className="badge review-publication-pending">Action required</span>}
      </div>
      <div className="review-action-row">
        {onOpenSession && run.source !== "existing" && <button className="btn review-icon-action" type="button"
          aria-label={sessionLabel} title={sessionLabel} aria-haspopup="dialog" onClick={() => onOpenSession(run.id)}>
          <Icon name={question ? "comment" : "chat"} />
        </button>}
        {active && <button className="btn review-icon-action" type="button" aria-label={stopLabel} title={stopLabel}
          disabled={working || run.state === "cancelling"} onClick={() => onCancel(run.id)}><Icon name="stop" /></button>}
        {onLifecycle && <ReviewLifecycle run={run} working={working} command={onLifecycle} load={loadAttempt} />}
      </div>
    </header>
    {publicationPending && <div className="review-publish-actions">
      <span>Choose whether to publish on GitHub.</span>
      <button className="btn btn-sm" type="button" aria-haspopup="dialog" onClick={() => setPublishOpen(true)}>Review publication</button>
    </div>}
    <div className="review-detail-meta">
      <span>{run.source === "manual" ? "Manual" : run.source === "scheduled" ? "Scheduled" : "Existing review"}</span>
      <time dateTime={run.createdAt}>{absoluteTime(run.createdAt)}</time>
      <span className="mono" title={run.id}>Run {run.id.slice(0, 8)}</span>
    </div>
    {onOpenSession && question && <p className="desk-run-reason">{questions.length > 1 ? questions.length + " questions need your answer" : (question.reviewerSessionId ? question.reviewer || "Reviewer" : "Coordinator") + " asks · " + question.question}</p>}
    {run.state === "running" && !question && <TranscriptUpdate at={run.lastActivityAt} />}
    {children}
    {run.options?.orchestrator !== false && (!question || run.reviewerProgress) &&
      <ReviewProgress progress={run.reviewerProgress} state={run.state} />}
    {!active && showOutcome && <ReviewOutcome run={run} />}
    <dl className="desk-run-facts">
      {run.source === "scheduled" && run.schedule && <>
        <dt>Triggered by</dt><dd>{run.schedule.ruleName} · {run.schedule.event === "push" ? "New head commit" : "Review request"}</dd>
        <dt>Run budget</dt><dd>{runLimits(run.schedule.budgetMinutes, run.schedule.budgetTokens)}</dd>
      </>}
      {run.options && <>
        <dt>Review mode</dt><dd>{run.options.mode === "auto" ? "Auto" : "Manual"} · {run.options.orchestrator === false ? "Single reviewer" : run.options.adaptive ? "Adaptive" : "Fixed tiers"}</dd>
        {run.options.flowId && <><dt>Associated Flow</dt><dd>#{run.options.flowId}</dd></>}
        <dt>Limits</dt><dd>{[
          run.options.maxWaves && `Up to ${run.options.maxWaves} waves`,
          run.options.maxParallel && `Up to ${run.options.maxParallel} reviewers at a time`,
          run.options.maxTokens ? `${run.options.maxTokens.toLocaleString()} tokens` : "Unlimited tokens",
        ].filter(Boolean).join(" · ")}</dd>
      </>}
      <dt>Requested range</dt><dd><Range value={run} /></dd>
      <dt>Phase</dt><dd role={active ? "status" : undefined}>{singleReviewerFinished(run) ? "Single reviewer finished" : run.phase}</dd>
      {run.startedAt && <><dt>Started</dt><dd><time dateTime={run.startedAt}>{absoluteTime(run.startedAt)}</time></dd></>}
      {run.finishedAt && <><dt>Finished</dt><dd><time dateTime={run.finishedAt}>{absoluteTime(run.finishedAt)}</time></dd></>}
      {result && <>
        <dt>Reviewed range</dt><dd>{result.reviewed ? <Range value={result.reviewed} /> : "Unconfirmed"}</dd>
        <dt>Coverage</dt><dd>{result.coverage || "Unconfirmed"}</dd>
      </>}
    </dl>
    {run.decision && <p className="desk-run-reason"><strong>Operator reason</strong> · {run.decision.reason}</p>}
    {active && run.reason && <p className="desk-run-reason">{run.reason}</p>}
    {result?.reviewed && !sameRange(result.reviewed, run) && <p className="inline-banner tone-warn">The recorded review covers a different range from the request.</p>}
    {run.usage ? <ReviewUsage usage={run.usage} /> : !active && <p className="review-detail-muted">Token usage was not recorded.</p>}
    {run.source !== "existing" || run.reviewerProgress ? <ReviewSessions onAnswer={onAnswer} working={working} answerError={answerError} run={run} activity={activity} loadAttempt={loadAttempt} onAccessLost={onAccessLost} /> : null}
    <ReviewReport run={run} loadAttempt={loadAttempt} onAccessLost={onAccessLost} />
    {draft && !publicationPending && <div className="review-publish-actions">
      <button className="btn btn-sm" type="button" aria-haspopup="dialog" onClick={() => setPublishOpen(true)}>
        {run.publication === "published" ? "View publication" : "Publish to GitHub"}
      </button>
      {run.publication === "skipped" && <span className="review-detail-muted">Publication skipped</span>}
    </div>}
    {draft && publishOpen && <ReviewPublishDialog cwd={draft.cwd} target={draft.target} id={run.id} command={draft.publishCommand}
      onAccessLost={onAccessLost} onDecision={onPublicationDecision} onClose={() => setPublishOpen(false)} />}
  </article>;
}

interface Props extends ReportProps {
  publication?: PublicationTarget;
  onAnswer: AnswerReviewQuestion;
  onLifecycle?: ReviewLifecycleCommand;
  activity: ActivitySubscription;
  card: ReviewCard; runs: DeskRun[]; error: string; working: boolean; loaded: boolean;
  onCancel: (id: string) => void; onRefresh: () => void; onOpenSession: (id: string) => void;
}

export function ReviewRuns({ activity, card, runs, error, loaded, working, onCancel, onRefresh, loadAttempt, onAccessLost, onOpenSession, onAnswer, onLifecycle, publication }: Props) {
  const latest = runs.find(run => runActive(run) && sameRange(run, card)) ?? runs.find(run => !reviewIsArchived(run));
  return <section className="desk-runs" aria-label="Latest Keryx review">
    <header className="desk-run-head"><h3>Latest review</h3><button className="btn review-icon-action" type="button"
      disabled={working} aria-label="Refresh runs" title="Refresh runs" onClick={onRefresh}><Icon name="refresh" /></button></header>
    <p className="review-detail-muted">GitHub review decision · {card.decision ? DECISION_LABEL[card.decision] : "No decision"}</p>
    {error && <p className="inline-banner tone-warn" role="alert">{error}</p>}
    {!loaded && !error && <Spinner label="Loading review history" />}
    {loaded && !latest && <p className="review-detail-muted">{runs.length ? "Archived reviews are available in History." : "No Keryx reviews for this pull request yet."}</p>}
    {latest && <RunAttempt key={latest.id} publication={publication} onPublicationDecision={onRefresh} onAnswer={onAnswer} answerError={error} onOpenSession={onOpenSession} activity={activity} run={latest} card={card} working={working} onCancel={onCancel} loadAttempt={loadAttempt} onAccessLost={onAccessLost} onLifecycle={onLifecycle} />}
  </section>;
}
