import type { DeskRun } from "../../../../src/review/desk-run-types";
import { RUN_STATE_LABEL, singleReviewerFinished } from "./ReviewProgress";

const severity = ["blocker", "major", "minor", "info"] as const;

export function ReviewOutcome({ run }: { run: DeskRun }) {
  const { result } = run;
  const solo = singleReviewerFinished(run);
  const findings = result && result.findingsKnown !== false ? result.findings : undefined;
  const counts = findings ? severity.filter(level => findings[level] > 0).map(level => `${findings[level]} ${level}`) : [];
  const missingContext = run.state === "partial"
    ? [...new Set(run.reviewerProgress?.sessions.filter(session => session.needsContext).map(session => session.reviewer))]
    : [];
  return <section className="review-session-outcome review-run-outcome" data-state={run.state} aria-label="Review result">
    <h3>Review result</h3>
    {result?.verdict ? <p className="review-verdict">{result.verdict}</p>
      : run.state === "partial" && !solo ? <p>Review ended before completion.</p>
      : !run.reason && <p>{run.state === "completed" ? "No verdict recorded." : RUN_STATE_LABEL[run.state]}</p>}
    {missingContext.length > 0 ? <p>Needs context · {missingContext.join(", ")}</p>
      : run.reason && !(run.state === "completed" && result?.verdict) && <p>{run.reason}</p>}
    {result && <p className="review-outcome-counts">
      {findings ? counts.join(" · ") || "0 findings recorded" : "Findings unrecorded"}
      {result.coverage === "partial" && (solo ? " · Single-reviewer coverage" : " · Partial coverage")}
    </p>}
  </section>;
}
