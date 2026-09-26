# Integrate Jev into review-orchestrator (jev-select, ci-triage report, jev-profile, TUI)

Status: implemented, PR open
Source: user description

## Problem

A live benchmark on a real project (a large production React/MobX frontend) measured Jev
(TypeSafe's "System One") across several review-domain roles. The results were mixed: CI triage
proved out strongly; three CLI-engine reviewers (review-jev-risk, review-jev-contract,
review-jev-rules) measured weaker than a strong model or added nothing; reviewer *selection* — which
of `review-orchestrator`'s ~27 sub-agent reviewers to actually dispatch per round — was named as the
most promising unmeasured cost lever. None of this evidence was wired into the orchestrator, and
there was no way for a project to turn on the parts that help without also being tempted to turn on
the parts that measurably do not.

## Expected Outcome

- `keryx review jev-select`: an advisory, opt-in, fail-open, recall-first filter over the candidate
  reviewer set, never skipping the Wave A core safety set.
- `review-orchestrator` SKILL.md/SKILL.detail.md (both byte-identical copies, within the 1723-line
  ceiling): wired to run `jev-select` (Step 5c) and `ci-triage` (Step 0b, extending the existing
  command rather than duplicating it), and updated with the measured verdicts for every CLI-engine
  reviewer, plus a pointer to the parallel `jev-edit-guard` feature for the FIX phase.
- `keryx review jev-profile [show|--apply recommended]`: a merge-safe recommended-profile helper.
- TUI: a `/jevprofile` modal, registered in `AGENT_SLASH_COMMANDS`/`HELP_GROUPS`, with
  `commands-by-task.md` regenerated.
- Tests for the policy (threshold, core-safety-never-skipped, fail-open, budget), the profile helper,
  the byte-identical SKILL copies, and the SKILL line ceiling.
- Docs: `docs/docs/jev-in-review.md`, README/docs-site links, cli-reference entries, CHANGELOG.
- A PR on `feat/jev-orchestrator`, green CI, not merged (left for the operator).

## Out of Scope

- Implementing `keryx review jev-edit-guard` itself — a separate, parallel PR (`feat/jev-edit-guard`).
- Re-measuring or changing the verdicts already recorded for CI triage /
  review-jev-risk/contract/rules — this flow *records* them, it does not re-run the benchmark.
- Changing the orchestrator's own model/tier routing.
