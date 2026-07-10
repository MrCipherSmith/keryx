# Implement Managed Review Feedback Loop from requirements docpack

Status: initialized for user plan confirmation
Source: `docs/requirements/managed-review-feedback-loop`

## Problem

`gdskills/review-orchestrator` can run after a Task Manager flow and surface
valid findings that are not durably attached back to the flow. The system loses
which reviewers ran, what coverage was skipped, how findings were classified,
and whether skill-learning or follow-up work should happen.

This weakens future `flow-orchestrator` runs because post-flow review feedback
does not become structured context.

## Expected Outcome

Implement the Managed Review Feedback Loop from the requirements package:

- related flow matching by explicit flow id, PR URL, issue URL, and branch;
- managed review packages for `attach-review`, `review-flow`, and `ingest`;
- durable required artifacts: `manifest.json`, `scope.md`, `coverage.md`,
  `report.md`, `findings.json`, `learning.md`, and `decisions.md`;
- schema validation for managed review manifests;
- preservation of lightweight review mode with no managed artifacts;
- runtime tests proving artifact creation and no direct `flow.json` mutation.

## Out of Scope

- Auto-applying code fixes from review findings.
- Applying skill-learning proposals without a read-and-approve step.
- Reopening completed flows for minor/info findings by default.
- Replacing the existing Task Manager flow lifecycle.
