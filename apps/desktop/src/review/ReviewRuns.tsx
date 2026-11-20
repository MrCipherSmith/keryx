import { useEffect, useState } from "react";
import { DESK_RUN_SCOPE, type DeskRevision, type DeskRun, type DeskRunState } from "../../../../src/review/desk-run-types";
import { Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import { DECISION_LABEL } from "./model";
import type { ReviewCard } from "./types";
import { runActive, sameRange } from "./useReviewRuns";
import { ReviewProgress } from "./ReviewProgress";
import { ReviewSessions, type LoadReviewAttempt, type ActivitySubscription } from "./ReviewSessions";
import { ReviewUsage } from "./ReviewUsage";
import { runLimits } from "./ReviewRuleInfo";

const STATE_LABEL: Record<DeskRunState, string> = {
  queued: "Queued", running: "In progress", cancelling: "Stopping", completed: "Completed",
  partial: "Partial", blocked: "Blocked", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped", budget: "Budget exhausted",
};

function Range({ value }: { value: DeskRevision }) {
  if (!value.baseSha && !value.headSha) return <>Unrecorded</>;
  return <span className="mono" title={value.baseSha + " → " + value.headSha}>
    {value.baseSha.slice(0, 9) || "Unknown base"} → {value.headSha.slice(0, 9) || "Unknown head"}
  </span>;
}

export function launchAction(runs: DeskRun[], card: ReviewCard) {
  const same = runs.find(run => run.source !== "existing" && sameRange(run, card));
  if (same && runActive(same)) return { open: true, label: "View active review" };
  if (same?.state === "completed" && same.scope === DESK_RUN_SCOPE && same.result?.coverage === "complete" && sameRange(same.result?.reviewed ?? null, card)) return { open: true, label: "View review result" };
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
    {open && (inline || report) && <pre>{inline || report}</pre>}
    {!inline && report === "" && <p>Report unavailable.</p>}
    {open && !error && !inline && report === null && <Spinner label="Loading report" />}
  </details>;
}

function RunAttempt({ run, card, onCancel, working, loadAttempt, onAccessLost, activity }: ReportProps & {
  activity: ActivitySubscription; run: DeskRun; card: ReviewCard; working: boolean; onCancel: (id: string) => void;
}) {
  const active = runActive(run);
  const result = run.result;
  const recorded = result?.reviewed ?? run;
  const historic = !!((recorded.headSha && recorded.headSha !== card.headSha) || (recorded.baseSha && recorded.baseSha !== card.baseSha));
  return <article className="desk-run" aria-label={'Review attempt ' + run.id}>
    <header className="desk-run-head">
      <strong className={active ? "review-live-state" : undefined}>{STATE_LABEL[run.state]}</strong>
      {historic && <span className="badge">Earlier revision</span>}
      {active && <button className="btn btn-sm" disabled={working || run.state === "cancelling"}
        onClick={() => onCancel(run.id)}>{run.state === "cancelling" ? "Stopping…" : "Stop review"}</button>}
    </header>
    <div className="review-detail-meta">
      <span>{run.source === "manual" ? "Manual" : run.source === "scheduled" ? "Scheduled" : "Existing review"}</span>
      <time dateTime={run.createdAt}>{absoluteTime(run.createdAt)}</time>
      <span className="mono" title={run.id}>Run {run.id.slice(0, 8)}</span>
    </div>
    <ReviewProgress progress={run.reviewerProgress} active={active} />
    <dl className="desk-run-facts">
      {run.source === "scheduled" && run.schedule && <>
        <dt>Triggered by</dt><dd>{run.schedule.ruleName} · {run.schedule.event === "push" ? "New head commit" : "Review request"}</dd>
        <dt>Run budget</dt><dd>{runLimits(run.schedule.budgetMinutes, run.schedule.budgetTokens)}</dd>
      </>}
      <dt>Requested range</dt><dd><Range value={run} /></dd>
      <dt>Phase</dt><dd role={active ? "status" : undefined}>{run.phase}</dd>
      {run.startedAt && <><dt>Started</dt><dd><time dateTime={run.startedAt}>{absoluteTime(run.startedAt)}</time></dd></>}
      {run.finishedAt && <><dt>Finished</dt><dd><time dateTime={run.finishedAt}>{absoluteTime(run.finishedAt)}</time></dd></>}
      {result && <>
        <dt>Reviewed range</dt><dd>{result.reviewed ? <Range value={result.reviewed} /> : "Unconfirmed"}</dd>
        <dt>Coverage</dt><dd>{result.coverage || "Unconfirmed"}</dd>
        <dt>Local verdict</dt><dd>{result.verdict || "No verdict recorded"}</dd>
        <dt>Findings</dt><dd>{result.findingsKnown === false ? "Unrecorded" : Object.entries(result.findings).map(([level, count]) => count + " " + level).join(" · ")}</dd>
      </>}
    </dl>
    {run.reason && <p className="desk-run-reason">{run.reason}</p>}
    {result?.reviewed && !sameRange(result.reviewed, run) && <p className="inline-banner tone-warn">The recorded review covers a different range from the request.</p>}
    {run.usage ? <ReviewUsage usage={run.usage} /> : !active && <p className="review-detail-muted">Token usage was not recorded.</p>}
    {run.source !== "existing" || run.reviewerProgress ? <ReviewSessions run={run} activity={activity} loadAttempt={loadAttempt} onAccessLost={onAccessLost} /> : null}
    <ReviewReport run={run} loadAttempt={loadAttempt} onAccessLost={onAccessLost} />
  </article>;
}

interface Props extends ReportProps {
  activity: ActivitySubscription;
  card: ReviewCard; runs: DeskRun[]; error: string; working: boolean; loaded: boolean;
  onCancel: (id: string) => void; onRefresh: () => void;
}

export function ReviewRuns({ activity, card, runs, error, loaded, working, onCancel, onRefresh, loadAttempt, onAccessLost }: Props) {
  return <section className="desk-runs" aria-label="Keryx review history">
    <header className="desk-run-head"><h3>Review history</h3><button className="btn btn-sm" disabled={working} onClick={onRefresh}>Refresh runs</button></header>
    <p className="review-detail-muted">GitHub review decision · {card.decision ? DECISION_LABEL[card.decision] : "No decision"}</p>
    {error && <p className="inline-banner tone-warn" role="alert">{error}</p>}
    {!loaded && !error && <Spinner label="Loading review history" />}
    {loaded && !runs.length && <p className="review-detail-muted">No Keryx reviews for this pull request yet.</p>}
    {runs.map(run => <RunAttempt key={run.id} activity={activity} run={run} card={card} working={working} onCancel={onCancel} loadAttempt={loadAttempt} onAccessLost={onAccessLost} />)}
  </section>;
}
