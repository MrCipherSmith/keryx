# Review engine speedup, step 1: no stop between waves (R1) and wave-events journal (R2)

Status: draft (flow-init skill formalizes this)
Source: user description (origin: human-request)

## Problem

In closed vantage-frontend rounds the longest gap with an authorized plan and open slices was 58 and 31 minutes in two of four rounds (2–4.5 minutes in the others). The orchestrator ended its turn or asked the operator "continue?" between waves, and nothing on disk shows it: `orchestrator.jsonl` records only memory calls. The keryx shell has a closing gate (`decideReviewGate`) but the Claude Code host does not.

## Expected Outcome

- R1: `review-orchestrator` has a rule for Claude Code: while the plan is authorized the orchestrator does not ask "continue?" and does not end the turn between waves; stops only on the closed list (nine operator cards, round ceiling, plan growth, irreversible, credentials, untrusted content). `keryx review next` prints a continuation line and `--json` carries `planAuthorized` / `continue`.
- R2: every `next` call appends one event to `<package>/tool-calls/wave-events.jsonl`; gaps over a threshold produce a warning and an `idle` event; the round summary shows how many gaps and the longest one. Decisions of `next` never depend on the journal.

## Outcome criteria

- Запрос (дословно): «/home/altsay/arena/ideas/pr-review-management/23_KERYX_IMPLEMENTATION_PROMPT.md» (source: Helyx message 226364, 2026-10-25)
- Эффект (формализация агента): after an authorized plan the round runs wave after wave without an operator question, and any pause longer than the threshold is visible in the package and in the round summary.
- Как наблюдать (предложение агента): `keryx review next --package <dir>` prints the continuation line and appends to `tool-calls/wave-events.jsonl`; `keryx review status` shows "Gaps without a launch…" when an `idle` event exists; replay on a copy of vantage-frontend #8086 reports a gap A of about 58 minutes.

## Out of Scope

R3–R6 of the package (they wait for the operator's word), E3.1–E3.6, E5, E6, E7, the PR-management service. No change to operator cards, the round ceiling or `decideReviewGate`. No metric acceptance on 5 new attended rounds (needs live rounds).
