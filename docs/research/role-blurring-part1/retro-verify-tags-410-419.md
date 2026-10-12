# Retrospective verification kinds for flows 410-419

This file records a verification kind for each acceptance criterion of keryx flows 410, 411, 412, 413, 414, 417, 418 and 419. The operator assigned the kinds retrospectively on 2026-10-10 and 2026-10-11. They were not set when the criteria were frozen.

The kinds are kept in a data file and not written into the criteria. Rewriting frozen criteria through `keryx flow ac update` would void the existing AC confirmations of flows 410 to 413. For analysis, treat these tags as retro tags, and keep them apart from kinds set at freeze time (flow 406, whose criteria carried their kind from the freeze).

Kinds:

- `exec`: checked by a command or test; the command is given.
- `invariant`: a test that something never happens; the command is given.
- `judged`: a person checks it.
- `none`: not checked, with a reason (no criterion uses it here).

Source: the operator's proposal of 2026-10-10 (verify-tags-406-419). The proposal named tests only by description, so each command was resolved against the code that shipped for the flow. Where a test was missing the criterion became `judged`.

Flows 415 and 416 do not exist in main and are skipped. Flows 407 to 409 still hold the placeholder criterion and are out of scope. Flow 419 is not implemented in main, so all its criteria are `judged` for now; revisit the kinds when it ships.

The sibling file `retro-verify-tags-410-419.json` holds the same data as an array of `{flow, criterion, kind, command, resolution}`.

Resolution values: `proposal` (kind taken as proposed; no test was needed or none named), `proposal; test file located...` (kind as proposed, the `bun test` command found in the shipped code), `test found` (a question mark in the proposal settled by an existing test), `no test -> judged` (the proposal said exec or invariant, no runnable test or command exists).

## Flow 410: pii-ssn-guard-second-review

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | exec | `bun test src/security/detect/pii-identifier-sweep.test.ts` | proposal; test file located from the flow's shipped diff |
| AC2 | exec | `bun test src/security/detect/pii-identifier-sweep.test.ts` | proposal; test file located from the flow's shipped diff |
| AC3 | exec | `bun test src/security/detect/pii-identifier-sweep.test.ts` | proposal; test file located from the flow's shipped diff |
| AC4 | exec | `bun test src/security/detect/pii-identifier-sweep.test.ts` | proposal; test file located from the flow's shipped diff |
| AC5 | invariant | `bun test src/security/detect/pii-linear-time.test.ts src/security/detect/pii-phone-linear-time.test.ts` | proposal; test file located from the flow's shipped diff |
| AC6 | judged | the proposal named a `flow check-completion` command that keryx does not have, and the real gate (`keryx flow complete`) changes flow state, so no read-only command exists; a person checks the review package | no test -> judged |
| AC7 | judged | operator confirmation (poll 97) | proposal |
| AC8 | judged | operator disposition of logic-R3-2 | proposal |

## Flow 411: routing-model-independence

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | exec | `bun test src/tui/routing-classifier-source.test.ts src/tui/routing-classifier-shell-wiring.test.ts` | proposal; test file located from the flow's shipped diff |
| AC2 | exec | `bun test src/tui/routing-classifier-source.test.ts src/tui/routing-classifier-shell-wiring.test.ts` | proposal; test file located from the flow's shipped diff |
| AC3 | exec | `bun test src/harness/decision/classify-turn.test.ts src/tui/routing-classifier-source.test.ts` | proposal; test file located from the flow's shipped diff |
| AC4 | exec | `bun test src/harness/decision/classify-turn.test.ts src/harness/routing/classifier-model.test.ts src/tui/routing-classifier-source.test.ts` | proposal; test file located from the flow's shipped diff |
| AC5 | exec | `bun test src/tui/routing-classifier-source.test.ts` | proposal; test file located from the flow's shipped diff |
| AC6 | exec | `bun test src/tui/routing-classifier-source.test.ts` | proposal; test file located from the flow's shipped diff |
| AC7 | exec | `bun test src/tui/routing-classifier-source.test.ts` | proposal; test file located from the flow's shipped diff |
| AC8 | exec | `bun test src/harness/decision/classify-turn.test.ts src/harness/decision/jev-client.test.ts src/tui/routing-classifier-shell-wiring.test.ts` | proposal; test file located from the flow's shipped diff |
| AC9 | exec | `bun test src/tui/routing-classifier-source.test.ts src/tui/routing-classifier-shell-wiring.test.ts src/tui/tui-shell.test.ts src/harness/decision/classify-turn.test.ts src/harness/decision/jev-client.test.ts src/harness/routing/classifier-model.test.ts` | proposal; test file located from the flow's shipped diff |
| AC10 | judged | consistency of PRD and docs, independent review and smoke | proposal |
| AC11 | judged | effect confirmed by the operator in a live session | proposal |

## Flow 412: pii-detector-separator-and-glue

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | exec | `bun test src/security/detect/pii-flow412-joined-phone.test.ts` | proposal; test file located from the flow's shipped diff |
| AC2 | exec | `bun test src/security/detect/pii-flow412-glue.test.ts` | proposal; test file located from the flow's shipped diff |
| AC3 | exec | `bun test src/security/detect/pii-flow412-separators.test.ts` | proposal; test file located from the flow's shipped diff |
| AC4 | exec | `bun test src/security/detect/pii-flow412-separators.test.ts` | proposal; test file located from the flow's shipped diff |
| AC5 | invariant | `bun test src/security/detect/pii-flow412-uuid-hash.test.ts` | proposal; test file located from the flow's shipped diff |
| AC6 | invariant | `bun test src/security/detect/pii-linear-time.test.ts src/security/detect/pii-phone-linear-time.test.ts src/security/detect/pii-flow412-coverage.test.ts`; the command covers the linear-time part; the 60,000-input differential against baseline 6f6d8898 is not a committed test | proposal; test file located from the flow's shipped diff |

## Flow 413: bound-tui-history-cost

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | exec | `bun test src/tui/composer-choice.test.ts` | proposal; test file located from the flow's shipped diff |
| AC2 | exec | `bun test src/tui/shell-chrome.test.ts` | proposal; test file located from the flow's shipped diff |
| AC3 | judged | the PTY measurement script ran from a temporary directory and was not committed; only the result table in verification.md exists | no test -> judged |
| AC4 | judged | review and recorded limitations | proposal |
| AC5 | judged | delivery only in a worktree, no merge | proposal |

## Flow 414: shell-auto-recovery

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | exec | `bun test src/commands/agent.recovery.test.ts src/commands/shell-agent-repl.test.ts src/tui/tui-shell.test.ts` | proposal; test file located from the flow's shipped diff |
| AC2 | exec | `bun test src/commands/agent.recovery.test.ts` | proposal; test file located from the flow's shipped diff |
| AC3 | exec | `bun test src/commands/agent.recovery.test.ts` | proposal; test file located from the flow's shipped diff |
| AC4 | invariant | `bun test src/commands/agent.recovery.test.ts` | proposal; test file located from the flow's shipped diff |
| AC5 | exec | `bun test src/commands/agent.recovery.test.ts src/tui/foreground-operation.test.ts` | proposal; test file located from the flow's shipped diff |
| AC6 | exec | `bun test src/commands/agent.recovery.test.ts` | proposal; test file located from the flow's shipped diff |
| AC7 | invariant | `bun test src/commands/agent.recovery.test.ts` | proposal; test file located from the flow's shipped diff |
| AC8 | exec | `bun test src/commands/shell-agent-repl.test.ts src/tui/tui-shell.test.ts` | test found (was '?'): readline event test and headless OpenTUI recovery test |
| AC9 | exec | `bun test src/commands/agent.recovery.test.ts src/commands/shell-agent-repl.test.ts src/tui/tui-shell.test.ts src/harness/provider/` | proposal; test file located from the flow's shipped diff |
| AC10 | judged | documentation | proposal |

## Flow 417: review-orchestrator-inline

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | exec | `bun test src/gdskills/review-orchestrator-preflight.test.ts` | proposal; test file located from the flow's shipped diff |
| AC2 | exec | `bun test src/gdskills/review-orchestrator-preflight.test.ts` | proposal; test file located from the flow's shipped diff |
| AC3 | invariant | `bun test src/gdskills/review-orchestrator-preflight.test.ts` | proposal; test file located from the flow's shipped diff |
| AC4 | exec | `bun test src/agents/tools.test.ts` | proposal; test file located from the flow's shipped diff |
| AC5 | exec | `bun test src/gdskills/review-orchestrator-preflight.test.ts` | test found (was 'judged?'): the AC5 block of the preflight test pins each element of the spawn recipe |
| AC6 | exec | `bun test src/review/caps.test.ts` | proposal; test file located from the flow's shipped diff |
| AC7 | exec | `bun test src/gdskills/review-orchestrator-preflight.test.ts src/review/round-need.test.ts` | proposal; test file located from the flow's shipped diff |
| AC8 | exec | `bun test src/gdskills/review-orchestrator-preflight.test.ts` | test found (was 'judged?'): a test asserts the skill's round ceiling equals REVIEW_ROUND_CAP |
| AC9 | exec | `bun test src/review/caps.test.ts` | proposal; test file located from the flow's shipped diff |
| AC10 | exec | `bun test src/gdskills/review-orchestrator-preflight.test.ts` | proposal; test file located from the flow's shipped diff |
| AC11 | judged | skill hygiene; bun test src/gdskills/review-orchestrator-preflight.test.ts pins part of it, but the criterion also covers judgement (emphasis style, a single model rule) | proposal |
| AC12 | judged | facade text lives in an external source; the journal names the owner | proposal |
| AC13 | exec | `bun test src/lib/orchestrators-inline.test.ts` | proposal; test file located from the flow's shipped diff |
| AC14 | judged | the mutation run was done by hand and recorded in the journal; it is not a re-runnable command (only the pass half is: bun test src/gdskills/review-orchestrator-preflight.test.ts src/review/caps.test.ts src/agents/tools.test.ts) | no test -> judged |
| AC15 | judged | documentation | proposal |
| AC16 | judged | live smoke recorded in the journal | proposal |

## Flow 418: shell-review-orchestration

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | exec | `bun test src/commands/agent-trust-orchestration.test.ts` | proposal; test file located from the flow's shipped diff |
| AC2 | exec | `bun test src/commands/agent-trust-orchestration.test.ts` | proposal; test file located from the flow's shipped diff |
| AC3 | exec | `bun test src/commands/agent-trust-orchestration.test.ts` | proposal; test file located from the flow's shipped diff |
| AC4 | exec | `bun test src/commands/agent-trust-orchestration.test.ts` | proposal; test file located from the flow's shipped diff |
| AC5 | exec | `bun test src/tui/busy-dispatch.test.ts` | test found (was '?'): busy slash commands are deferred, queued with a notice and drained when the turn settles |
| AC6 | exec | `bun test src/tui/ctrl-c-policy.test.ts` | test found (was '?'): Ctrl+C policy tests |
| AC7 | exec | `bun test src/review/slice-dispatch.test.ts` | proposal; test file located from the flow's shipped diff |
| AC8 | exec | `bun test src/review/slice.test.ts` | proposal; test file located from the flow's shipped diff |
| AC9 | exec | `bun test src/review/slice-dispatch.test.ts src/review/dispatch.test.ts` | proposal; test file located from the flow's shipped diff |
| AC10 | exec | `bun test src/commands/agent-trust-orchestration.test.ts src/review/caps.test.ts` | proposal; test file located from the flow's shipped diff |
| AC11 | exec | `bun test src/harness/tool/builtin/interactive-tools.test.ts src/commands/ctx.test.ts` | proposal; test file located from the flow's shipped diff |
| AC12 | judged | live run of a review of a PR in a medium-sized work project; not repeatable as a command | proposal |
| AC13 | judged | documentation | proposal |

## Flow 419: telegram-remote-control-relay

| AC | kind | command or reason | how resolved |
|---|---|---|---|
| AC1 | judged | the flow is not implemented in main (status ready, no task done, no PR), so no test of this behaviour exists | no test -> judged |
| AC2 | judged | the flow is not implemented in main (status ready, no task done, no PR), so no test of this behaviour exists | no test -> judged |
| AC3 | judged | the flow is not implemented in main (status ready, no task done, no PR), so no test of this behaviour exists | no test -> judged |
| AC4 | judged | the flow is not implemented in main (status ready, no task done, no PR), so no test of this behaviour exists | no test -> judged |
| AC5 | judged | the flow is not implemented in main (status ready, no task done, no PR), so no test of this behaviour exists | no test -> judged |
| AC6 | judged | the flow is not implemented in main (status ready, no task done, no PR), so no test of this behaviour exists | no test -> judged |
| AC7 | judged | the flow is not implemented in main (status ready, no task done, no PR), so no test of this behaviour exists | no test -> judged |
| AC8 | judged | live run only through Telegram | proposal |
| AC9 | judged | documentation | proposal |

## Totals

| kind | count |
|---|---|
| exec | 47 |
| invariant | 6 |
| judged | 25 |
| none | 0 |
| total | 78 |

Per flow: 410: 8, 411: 11, 412: 6, 413: 5, 414: 10, 417: 16, 418: 13, 419: 9.
