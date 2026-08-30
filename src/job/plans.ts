import type { JobIntent, JobStep } from "./types";

// The default plans, transcribed from §1.1 of the job-orchestrator skill.
//
// They are here rather than in prose because a plan that exists only in a
// Markdown list is a plan no `job status` can report progress against — which
// is precisely how a documented step could be "completed" by an agent's memory
// and by nothing else. `conditional: true` is preserved from the skill and is
// NOT an exemption from the completion gate: a conditional step that did not run
// must be recorded `--status skipped --reason "<why>"`.

type PlanTemplate = ReadonlyArray<Omit<JobStep, "status">>;

const IMPLEMENT: PlanTemplate = [
  { id: "analyze", type: "analyze", agent: "issue-analyzer", depends: [] },
  { id: "context", type: "context", agent: "context-collector", depends: ["analyze"] },
  { id: "prepare", type: "prepare", agent: "orchestrator", depends: ["context"] },
  { id: "tests-creator", type: "tests", agent: "tests-creator", depends: ["prepare"] },
  { id: "implement", type: "implement", agent: "task-implementer", depends: ["tests-creator"] },
  { id: "sanity-check", type: "check", agent: "orchestrator", depends: ["implement"] },
  { id: "verify", type: "verify", agent: "code-verifier", depends: ["sanity-check"] },
  { id: "review", type: "review", agent: "code-review", depends: ["verify"] },
  { id: "security", type: "security", agent: "security-audit", depends: ["implement"], conditional: true },
  { id: "fix", type: "fix", agent: "task-implementer", depends: ["review"], conditional: true },
  { id: "verify-post-fix", type: "verify", agent: "code-verifier", depends: ["fix"], conditional: true },
  { id: "perf-check", type: "perf", agent: "perf-check", depends: ["verify"], conditional: true },
  { id: "report", type: "report", agent: "orchestrator", depends: ["verify"] },
  { id: "pr", type: "pr", agent: "orchestrator", depends: ["report"], conditional: true },
  { id: "deploy", type: "deploy", agent: "deploy", depends: ["pr"], conditional: true },
];

const ANALYZE: PlanTemplate = [
  { id: "analyze", type: "analyze", agent: "issue-analyzer", depends: [] },
  { id: "context", type: "context", agent: "context-collector", depends: ["analyze"] },
  { id: "report", type: "report", agent: "orchestrator", depends: ["context"] },
  { id: "proposal", type: "proposal", agent: "orchestrator", depends: ["report"] },
];

const REVIEW: PlanTemplate = [
  { id: "context", type: "context", agent: "context-collector", depends: [] },
  { id: "review", type: "review", agent: "reviewers", depends: ["context"] },
  { id: "report", type: "report", agent: "orchestrator", depends: ["review"] },
];

/**
 * `custom` builds its plan dynamically per the skill. It still gets the two
 * steps every job has, so the package is never created with an empty plan the
 * schema would have to be widened to accept.
 */
const CUSTOM: PlanTemplate = [
  { id: "context", type: "context", agent: "context-collector", depends: [] },
  { id: "report", type: "report", agent: "orchestrator", depends: ["context"] },
];

const PLANS: Record<JobIntent, PlanTemplate> = {
  implement: IMPLEMENT,
  analyze: ANALYZE,
  review: REVIEW,
  custom: CUSTOM,
};

export function defaultPlan(intent: JobIntent): JobStep[] {
  return PLANS[intent].map((step) => ({
    ...step,
    depends: [...(step.depends ?? [])],
    status: "pending" as const,
  }));
}
