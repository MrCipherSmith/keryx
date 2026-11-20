import type { ReviewRule, ReviewRuleActivity } from "../../../../src/review/review-rule-types";
import { absoluteTime } from "../lib/format";

export function runLimits(minutes: number, tokens: number | null | undefined) {
  const limit = tokens === undefined ? "Token limit unrecorded" : tokens === null ? "No token limit" : `${tokens.toLocaleString()} tokens`;
  return `${minutes} min · ${limit}`;
}

export function describeRule(rule: ReviewRule) {
  const scope = [rule.author && "from " + rule.author, rule.assignee && "assigned to " + rule.assignee].filter(Boolean).join(" and ");
  const prs = scope ? "open PRs " + scope : "all open PRs";
  const event = rule.event === "push"
    ? "a new head commit" + (rule.reviewer ? " with a pending review request for " + rule.reviewer : "")
    : "a new or repeated review request" + (rule.reviewer ? " for " + rule.reviewer : "");
  return "For " + prs + ", start a review on " + event + (rule.requireGreen ? " once CI passes for that commit." : ".");
}

const states = { waiting: "Waiting", ready: "Ready", started: "Started", linked: "Linked", skipped: "Skipped" } as const;

export function RuleActivity({ events, showNumber = false }: { events: ReviewRuleActivity[]; showNumber?: boolean }) {
  return <section className="automation-history" aria-label="Automation activity">
    <h3>Automation activity</h3>
    {events.length === 0 ? <p className="review-detail-muted">No rule activity recorded yet.</p> : <ol>
      {events.map((event, i) => <li key={[event.number, event.at, event.state, i].join("-")}>
        <div><strong>{showNumber && "#" + event.number + " · "}{states[event.state]}</strong>
          {" · "}<time dateTime={event.at}>{absoluteTime(event.at)}</time></div>
        <p>{event.reason}</p><small className="mono" title={event.headSha}>{event.headSha.slice(0, 9)}
          {event.runId && " · Run " + event.runId.slice(0, 8)}</small>
      </li>)}
    </ol>}
  </section>;
}
