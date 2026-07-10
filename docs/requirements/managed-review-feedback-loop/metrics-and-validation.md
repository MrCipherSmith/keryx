# Managed Review Metrics and Validation
Version: 0.2.0

## Purpose

Define how to validate that managed review improves review traceability and
skill-learning feedback without making every review too heavy.

## Metrics

| Metric | Target |
|---|---|
| Review package completeness | 100% of managed reviews contain required artifacts. |
| Coverage explicitness | 100% of managed reviews list run/skipped reviewers with reasons. |
| Learning handoff explicitness | 100% of managed reviews contain `Skill Learning` candidates or `none`. |
| Post-flow classification | 100% of attached post-flow findings have a classification. |
| Lightweight mode preservation | Existing report-only review path remains available. |

## Validation Scenarios

### Scenario 1: Attach Review To Existing Flow

Given a flow has a PR URL in its flow metadata,
when the managed review caller reviews that PR in compatibility attach mode,
then it writes a review package under the flow's `reviews/` directory.

### Scenario 2: Post-Flow Review Ingest

Given a completed flow and a later review report,
when the report is ingested,
then each finding is classified and learning candidates are recorded without
reopening the flow by default.

### Scenario 3: Reviewer Coverage Gap

Given a flow review ran only one reviewer,
when a later review finds issues from a skipped reviewer domain,
then the managed review package records a `missed_by_flow_gate` or
`valid_followup` decision with rationale.

### Scenario 4: Skill Learning Candidate

Given a finding should have been prevented by a project or process skill,
when the review package is completed,
then `learning.md` names the target skill and source finding ids.

### Scenario 5: Lightweight Review

Given the user requests a quick review,
when no managed mode is selected,
then the system prints a report without creating review artifacts.

## Test Strategy

- Unit-test flow matching by PR URL, issue URL, branch, and explicit flow id.
- Unit-test manifest schema validation.
- Unit-test finding classification output shape.
- Integration-test attach-review artifact creation in a temporary
  `.metaproject/flows/<id>/` workspace.
- Regression-test that `flow.json` is not edited directly by managed review.

## Review Gates

Before implementation is accepted:

- schema validation passes for sample `manifest.json`;
- managed review package contains every required document;
- links from README and specification resolve;
- docpack-review reports no blockers;
- runtime tests cover attach-review, review-flow, ingest, and lightweight modes.

Per-reviewer Task Manager lifecycle, model routing, token reuse, and resume
validation are specified separately in
[Flow Reviewer Metrics and Validation](../flow-reviewer/metrics-and-validation.md).
