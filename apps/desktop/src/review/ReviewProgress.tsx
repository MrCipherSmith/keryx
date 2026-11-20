import { useEffect, useState } from "react";
import type { DeskReviewerProgress, DeskRun, DeskRunState } from "../../../../src/review/desk-run-types";
import { absoluteTime } from "../lib/format";
import type { ReviewCard } from "./types";

export const RUN_STATE_LABEL: Record<DeskRunState, string> = {
  queued: "Queued", running: "In progress", cancelling: "Stopping", completed: "Completed",
  partial: "Partial", blocked: "Blocked", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped", budget: "Budget exhausted",
};

export function pendingManualQuestions(run: DeskRun) {
  if (run.state !== "running" || run.source !== "manual") return [];
  return run.pendingQuestions ?? (run.pendingQuestion ? [run.pendingQuestion] : []);
}

export function pendingManualQuestion(run: DeskRun) {
  return pendingManualQuestions(run)[0];
}

export function runStatusLabel(run: DeskRun) {
  if (run.decision?.action === "archive") return "Archived";
  if (run.closure === "closed") return "Closed as incomplete";
  if (run.closure === "completed") return run.result?.coverage === "complete" ? "Completed" : "Completed by operator";
  return pendingManualQuestion(run) ? "Awaiting your answer" : RUN_STATE_LABEL[run.state];
}

export function TranscriptUpdate({ at }: { at?: string | undefined }) {
  const recorded = at ? Date.parse(at) : NaN;
  const [, refresh] = useState(0);
  useEffect(() => {
    const untilQuiet = recorded + 120_000 - Date.now();
    if (!Number.isFinite(untilQuiet) || untilQuiet <= 0 || untilQuiet > 2_147_483_647) return;
    const timer = window.setTimeout(() => refresh(n => n + 1), untilQuiet);
    return () => window.clearTimeout(timer);
  }, [recorded]);
  if (!Number.isFinite(recorded)) return <span className="review-activity-stamp">No transcript activity recorded yet</span>;
  const quiet = Date.now() - recorded >= 120_000;
  return <span className="review-activity-stamp">
    {quiet ? "No recent transcript events · last update " : "Transcript updated "}<time dateTime={at}>{absoluteTime(at)}</time>
  </span>;
}

type Roster = Omit<DeskReviewerProgress, "sessions">;

function runProgress(state: DeskRunState, progress?: Roster) {
  if (state === "completed") return { percent: 100, label: "Review completed" };
  const { planned, completed = progress?.finished === 0 ? 0 : undefined } = progress ?? {};
  if (planned != null && Number.isSafeInteger(planned) && planned > 0 &&
      completed != null && Number.isSafeInteger(completed) && completed >= 0 && completed <= planned) {
    // Starting accounts for 5%. Reserve the final 5% for consolidation and the completion gate.
    return { percent: 5 + Math.floor(90 * completed / planned), label: `${completed} of ${planned} assignments completed` };
  }
  if (state === "queued") return { percent: 5, label: "Queued" };
  if (state === "running" || state === "cancelling") {
    return { percent: 5, label: "Assignment totals pending" };
  }
  return { percent: null, label: "Progress unavailable" };
}

export function ReviewProgress({ progress, state, showState }: {
  progress?: Roster; state: DeskRunState; showState?: boolean;
}) {
  const { percent, label } = runProgress(state, progress);
  return <span className="review-progress">
    <span className="review-progress-caption">
      {progress?.wave != null && <span className="review-wave">Wave {progress.wave}</span>}
      {percent != null && <strong>{percent}%</strong>}
      <span>{showState && !["running", "queued", "completed"].includes(state) && RUN_STATE_LABEL[state] + " · "}{label}</span>
    </span>
    {percent != null && <span role="progressbar" aria-label="Review progress" aria-valuetext={`${percent}% · ${label}`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="review-progress-track">
      <span style={{ width: percent + "%" }} />
    </span>}
  </span>;
}

export function CardReviewProgress({ badge }: { badge: ReviewCard["localReview"] }) {
  if (badge?.runState === "other-revision") return <span className="review-progress-caption">Reviewing an earlier revision</span>;
  const state = badge?.runState ?? (badge?.active ? "running" : undefined);
  if (!state) return null;
  return <>
    {(!badge?.awaitingAnswer || badge.progress) && <ReviewProgress state={state} progress={badge?.progress} showState />}
    {state === "running" && !badge?.awaitingAnswer && <TranscriptUpdate at={badge?.lastActivityAt} />}
  </>;
}
