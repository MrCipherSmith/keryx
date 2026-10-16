/**
 * Held findings and premise answers, written by hand, for tests (flow 459).
 *
 * TEST SCAFFOLDING. Nothing in the shipped CLI imports this module. It lives outside a `.test.ts` file for the reason
 * `src/flow/review-fixtures.ts` does: several suites need the same held finding and the same answer (the decision
 * store, the verdict, readiness, the flow gate, the CLI command and the card), and importing one test file from another
 * would run its tests twice.
 */

import type { PremiseQuestionDecision } from "./operator-decisions";
import { premiseSubjectOf } from "./premise";

/** A finding the premise judge held (`challenged`), in the shape findings.json stores. */
export function heldFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "LY-003",
    global_id: "r1#LY-003",
    reviewer: "review-layout",
    severity: "major",
    problem: "timeline pinned LTR",
    impact: "i",
    suggested_fix: "f",
    evidence: "e",
    confidence: "high",
    premise: { verdict: "challenged", judge: "review-premise", question: "mirror it?" },
    ...over,
  };
}

/**
 * A complete `premise-question` decision answering `finding`: bound to what that finding is (its subject), confirmed at
 * a terminal, with the operator's words. `over` replaces any field, `subject` included.
 */
export function premiseAnswer(finding: Record<string, unknown> = heldFinding(), over: Partial<PremiseQuestionDecision> = {}): PremiseQuestionDecision {
  const subject = premiseSubjectOf(finding);
  if (subject === undefined) throw new Error("premiseAnswer needs a finding that carries a premise");
  return {
    kind: "premise-question",
    finding: typeof finding.global_id === "string" ? finding.global_id : String(finding.id),
    answer: "dismiss",
    reason: "platforms do not mirror media controls",
    quote: "yes, dismiss it",
    at: "2026-10-16T12:00:00Z",
    actor: "operator",
    confirmedVia: "terminal",
    subject,
    ...over,
  };
}

/** {@link premiseAnswer} without the fields the store fills in, for `recordPremiseDecision`. */
export function premiseAnswerInput(finding: Record<string, unknown> = heldFinding(), over: Partial<PremiseQuestionDecision> = {}): Omit<PremiseQuestionDecision, "kind" | "actor"> {
  const { kind: _kind, actor: _actor, ...input } = premiseAnswer(finding, over);
  return input;
}
