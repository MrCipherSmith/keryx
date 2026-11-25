# Desktop Review v3: live review session per round and review.json state

Status: formalized
Source: coordinating session handoff (owner-approved v3 design, evidence from the owner's local review store, 2026-11-25)

## Problem

Manual Desktop reviews (Keryx 0.4.55/0.4.56, Desktop 0.2.18/0.2.19) run as detached headless one-shot `keryx shell --no-tui --print` processes in per-attempt checkouts. On three Presight-AI/vantage-frontend PRs (9249, 9320, 9264) ten attempts never reached reviewers (`rounds: 0`, `reviewers: []`, 0.5–0.7M coordinator tokens each, partial/blocked): Continue restarted cold in a fresh checkout without the prior package (ENOENT on plan.json, slices/manifest.json); a `shell_exec` floor could not be approved headless; an OpenAI 403 answered by Continue was another cold restart; user questions became `guidance` nobody answered; the ACP session created at start only owns the attempt, so typing into it reaches an unrelated agent; status uses four vocabularies. The same review-orchestrator skill in a live session works.

## Expected Outcome

- docs/requirements/keryx-desktop-review-v3/ (README, prd, specification, implementation-plan; Russian, v2 style) describes the v3 model, the review.json schema and v2 migration, the CLI verbs, the session→card status mapping, the stages, what v3 supersedes in v2, and the owner decisions.
- Stage 1: a durable `review.json` + `journal.md` per PR review under `.metaproject/reviews/pr/<review-id>/`, written only by `keryx review state …`; the review-orchestrator skill calls it at each step; "Run review" on the board, the Reviews tab and the session `/review` dialog opens or reuses the PR-bound session (bound via `subject`) and sends a review turn there, with no detached worker; "Continue review" sends a turn into the same session; v2 data keeps displaying.

## Outcome criteria

- Share of manual Desktop reviews with at least one reviewer wave, read from `review.json rounds[].reviewers` over the owner's first week (today 0 of 10).

## Out of Scope

- Stages 2–4: Desktop reading review.json, unified status/card, v2 import, New round via session + advance, publish writing review.json, head-move stale marking, removing the detached worker code.
- Scheduled/watcher reviews (keep the detached executor).
- Desktop Rust changes.
