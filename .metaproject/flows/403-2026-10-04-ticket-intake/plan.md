# Implementation Plan

Status: frozen with the operator's approval (poll 84, 2026-10-04). PRD: `docs/requirements/keryx-ticket-intake/prd.md`.

## Approach

Intake is one more trigger on the flow 295/389 scheduler machinery (`src/scheduler/digest-*`), not a second scheduler. A poll reads GitHub through granted read-only gh-tools, turns each new event into one Telegram HTML card with buttons, and routes presses back through a registry-driven handler. Nothing mutates GitHub; "Take into work" runs `flow init --issue` locally with origin `agent-proposal`. Decisions go to an own ledger (`.metaproject/data/intake/ledger.jsonl`), without the F2 arms, with an export compatible with `keryx decisions export`. Cards go to a dedicated service topic "Intake" with its own hub route. Rejected alternative: GitHub Action and webhook (deferred to flow D2 after a week of polling).

## Parts (independent where marked)

1. Polling and events (`src/intake/`): five event kinds, event keys, baseline poll, dedupe, quiet hours, rate limit, budget/timeout, failure handling. AC1-3, 14-17, 21.
2. Cards and buttons: one model call without tools, redaction via `src/security`, HTML escaping, buttons per kind, `callback_data` with card id and action code only. AC4-5.
3. Actions: take (`flow init --issue`), decline/skip/ignore/understood, later (one reminder), review-flow, ci-triage; press guards, allowlist, restart safety. AC6-13.
4. Registry and report: ledger, `keryx intake` CLI, `report --json`. AC20.
5. Hub route for the Intake service topic (`src/remote/service-topics.ts`), session topics unchanged. AC18.
6. TUI surfaces (side panel line, `/intake` modal, menu item, slash command, readline text equivalent), one status object. AC19.
7. Documentation: README, cli-reference, wiki, commands-by-task, docs site, CHANGELOG (no version bump here). AC22.

Parts 1, 4 and 5 are independent; 2, 3 and 6 build on the registry types from part 4.

## Steps

1. Freeze AC, start the flow.
2. Worker tasks per part, each with targeted tests only and fakes only (no live gh, Telegram, model, external agents).
3. Independent review with fresh reviewers; every finding is fixed (only the operator may dismiss one).
4. Draft PR, green CI, merge commit.
5. Documentation, then `keryx flow implemented 403 --pr <url>`. The flow is not closed: AC23-AC25 are live or judged and the operator confirms them.

## Risks

- The hub drops callbacks from topics without a session as `update-unrouted`; the new route must not change behaviour for session topics.
- Work repositories (`~/work/**`) are read-only; "Take into work" stays off there until enabled by config.
- Model cost per poll: budget $0.50 per run, enforced.
- Flaky `install-state.test.ts` in CI: rerun only the failed job.
