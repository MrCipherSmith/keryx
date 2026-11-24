import type { IssueSummary } from "../../../../src/integrations/issues-contract";
import type { WorkAction } from "./IssueWork";
import { issueName, STAGES } from "./model";

/**
 * The Keryx work row of an Issue card or list row: a Flow slot and a session slot, in the look and fixed
 * height of the PR work row. A slot holds a link to the issue's work, or its labelled action when there is none.
 */
export function IssueWorkRow({ issue, bound, pending, onAction }: {
  issue: IssueSummary; pending: boolean; onAction: (action: WorkAction) => void;
  /** Non-archived sessions bound to the issue through their `subject`; the board indexes them once for all rows. */
  bound: number;
}) {
  const stage = issue.work?.stage ?? "none";
  const flowText = stage === "none" ? "Create Flow" : `Flow · ${STAGES[stage]}`;
  const sessionText = bound > 1 ? `${bound} sessions` : bound ? "Session"
    : stage === "needs_answer" ? "Open question" : "Open in session";
  const of = " for " + issueName(issue);
  return <div className="pr-work-row issue-work-row" role="group" aria-label={"Keryx work" + of}>
    <span className="pr-work-slot" data-slot="flow">
      <button type="button" className={"pr-work-link" + (stage === "none" ? " is-empty" : "")} title={flowText}
        aria-label={flowText + of} disabled={pending}
        onClick={() => onAction(stage === "none" ? "prepare-flow" : "open-flow")}>{flowText}</button>
    </span>
    <span className="pr-work-slot" data-slot="session">
      {/* open-session reuses the session bound to the issue, so one link serves both counts. */}
      <button type="button" className={"pr-work-link" + (bound ? "" : " is-empty")}
        title={stage === "needs_answer" && !bound ? "Open question in Sessions" : sessionText}
        aria-label={sessionText + of} disabled={pending} onClick={() => onAction("open-session")}>{sessionText}</button>
    </span>
  </div>;
}
