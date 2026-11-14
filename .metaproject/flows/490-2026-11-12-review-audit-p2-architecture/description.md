# Review architecture: round state machine in code, byte ceiling for skills, staged modules, one host port (audit P2)

Status: draft
Source: docs/analysis/review-process-audit-2026-11-12.md, section "Архитектура" and "Харнесы" (origin: agent-finding)

## Problem

A review round has no state model in code. The order of steps lives in 233 KB of orchestrator prose (`SKILL.md` 147 KB, `SKILL.detail.md` 86 KB), and the code is 58 independent subcommands that each re-derive state from package files. Every new failure is therefore answered with a new paragraph and a new gate: 93 commits to the orchestrator skill in 60 days.

- Rules exist twice. `classifyRoundNeed` (`src/review/round-need.ts:102`) has no caller outside tests; the agent executes the same rule from prose (`SKILL.md:29`).
- The skill length ceiling counts lines and only moves down (`src/gdskills/skill-length-ceilings.ts`). The orchestrator sits exactly at 1571 lines and grows inside lines: the longest is 5023 characters (`SKILL.md:128`). `SKILL.detail.md` has no ceiling.
- The lifecycle enum has five statuses; only `draft` and `closed` are written.
- `src/commands/review.ts` is 5940 lines; `src/review/managed.ts` is 3187 lines; `src/review` holds 161 non-test modules in one directory. Eight `jev-*-config.ts` files are the same reader with a different key.
- Four unrelated abstractions share the word "host": `host-profile.ts`, `completion-host.ts`, the hierarchical `review/agents` engine and the flat path's package files.
- `ingest` and `ledger build` write `findings.json` and `research.json` without the completion lock; the completion snapshot omits files that readiness reads.
- No test runs start, slice, ledger, ingest, complete and publish end to end on a ledger that `ledger build` produced.
- Codex, opencode and Grok are routed to the autonomous runner on keryx's own provider; opencode and Grok are not in `REVIEW_HOSTS`.

## Expected Outcome

The round's next step is computed by keryx, not read from prose; the orchestrator skill shrinks to executing what the command returns; skills are bounded by bytes; the review code is grouped by stage; one host port describes what each harness can do.

## Outcome criteria

- Источник: docs/analysis/review-process-audit-2026-11-12.md
- Эффект (формализация агента): an agent on any host drives a round by repeatedly asking keryx for the next step and its inputs; rules such as "is a round needed" are evaluated by a command; the orchestrator skill is materially smaller; adding a host or a gate touches one declared place.
- Как наблюдать (предложение агента): the byte size of `review-orchestrator/SKILL.md` plus `SKILL.detail.md` before and after; an end-to-end test that completes a fixture round using only the step command; the number of files touched to add a host value.

## Out of Scope

- Behaviour changes to gates (flow 488) and to scoring or reports (flow 489).
- New reviewers or new harness adapters for opencode and Grok beyond naming them in the capability matrix.
- This flow is large. It is expected to be split into phases after `flow plan`; the criteria below describe the end state.
