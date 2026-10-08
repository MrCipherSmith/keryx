# Flow 414 implementation handoff

> **Independent-review continuation:** the original handoff below is historical.
> The rejected SSE reader and session-switch blockers were repaired afterward;
> see [continuation-report.md](continuation-report.md) for exact commands, passing
> focused fixtures, broader failures and limits. Flow remains in-progress with
> zero AC confirmations. No git publication occurred.

Date: 2026-10-08. Worktree: `/Users/tsaitler.aleksandr/goodea/keryx/.worktrees/shell-auto-recovery`.
Branch: `feat/shell-auto-recovery`. Both checked before writes and again at handoff.
No commit, push, merge, tag, release, stash or other-worktree edit was performed.

Implementation is ready for the main agent's review and git handling. Flow remains
`in-progress`: T1/T2/T3/T5/T6/T7 are done; T4 is open. Frozen AC text is unchanged,
and no AC has been formally confirmed. Evidence below is verification evidence,
not a claim that the complete flow/review gate passed.

## Behavior implemented

- Interactive-host opt-in to an inner transport-attempt loop within each model round.
- Retryable structured provider errors, recognized thrown transport errors, missing
  model_end and adapters' explicit incomplete-stream errors recover automatically.
- Interruptible exponential jitter: 0.5–1 s initially, 30–60 s after reaching the
  cap; Retry-After is a minimum capped at 300 s. Seconds and HTTP dates are supported.
  No short retry-count limit; cancellation, permanent errors and budgets terminate.
- Provisional text/reasoning/tool calls never enter persisted history until model_end.
  Failed output is marked interrupted and live renderer state is reset. No failed
  tool batch executes. Previous tool results, approvals and counters remain in turn.
- Retry attempts do not consume successful model-round budget. Failed reported usage
  reaches existing host accounting; missing usage is explicitly unknown. Output-token
  limits remain set and an injected host request-admission ceiling is respected.
- Readline shutdown and lease loss abort stream/backoff. TUI keeps foreground ownership
  until settlement, cancels on lease loss/session switch, and resets live thought previews.
- Generic 403/auth/invalid requests terminate with provider access guidance. The
  existing bounded provider-owned credential refresh remains unchanged.
- Print, unattended, ACP, subagent and side-worker hosts do not enable recovery.

## Exact reviewable files changed in this implementation

- `README.md`
- `docs/docs/shell-recovery.md`
- `src/commands/agent.ts`
- `src/commands/agent.recovery.test.ts`
- `src/commands/shell.ts`
- `src/commands/shell-agent-repl.test.ts`
- `src/commands/shell-bus.test.ts`
- `src/commands/shell.test.ts`
- `src/harness/provider/types.ts`
- `src/harness/provider/provider-port.ts`
- `src/harness/provider/provider-port.test.ts`
- `src/harness/provider/anthropic/anthropic-provider.ts`
- `src/harness/provider/compat/openai-compat-provider.ts`
- `src/harness/provider/gemini/gemini-provider.ts`
- `src/harness/provider/openai/openai-provider.ts`
- `src/tui/foreground-operation.ts`
- `src/tui/tui-shell.ts`
- `src/tui/tui-shell.test.ts`
- `.metaproject/flows/414-2026-10-08-shell-auto-recovery/flow.json`
- `.metaproject/flows/414-2026-10-08-shell-auto-recovery/journal.md`
- `.metaproject/flows/414-2026-10-08-shell-auto-recovery/implementation-evidence.md`

The other files in the untracked flow directory existed at session start and were
read without modification. `flow.json` and task journal entries were updated only
through `keryx flow task done`. Generated graph artifacts were restored to their
original tracked bytes to avoid unrelated diff noise; the ignored local graph
storage was refreshed. gdctx produced ignored raw logs/summaries during verification.
Dependency installation did not change the lockfile or package manifest.

## Verification results

| Check | Result | Evidence |
|---|---|---|
| Focused recovery/provider/agent/context/shell/OpenTUI regression command below | 949 pass, 0 fail; 43 files | gdctx `2026-10-08T10-19-26-231Z-d9c22b_run` |
| Final recovery file after fixture typing cleanup | 26 pass, 0 fail; 92 assertions | gdctx `2026-10-08T10-20-18-509Z-f47841_run` |
| Readline + recovery + provider-port tests, including injected lease loss | 100 pass, 0 fail | gdctx `2026-10-08T10-16-20-474Z-148044_run` (before final native adapter test was added) |
| Main TypeScript typecheck | Pass | gdctx `2026-10-08T10-20-16-790Z-6ac6ed_run` |
| Scripts TypeScript typecheck | Pass | gdctx `2026-10-08T10-19-28-205Z-f9aaa9_run` |
| ESLint of all changed TypeScript paths | Pass | gdctx `2026-10-08T10-19-30-892Z-af567c_run`; final agent/recovery-file repeat `2026-10-08T10-20-18-066Z-5b5e1b_run` |
| git diff whitespace check | Pass | direct `git diff --check`, no output |
| Frozen dependency install | Pass | TMPDIR=/private/tmp and BUN_INSTALL_CACHE_DIR=/private/tmp/keryx-flow414-bun-cache; manifest/lock unchanged |
| Broader agent/shell/provider sweep | 1516 pass, 3 skipped, 3 failed initially | gdctx `2026-10-08T10-16-32-124Z-fc054b_run`; two stale source audits fixed |
| Lease/bus/lifecycle-hook follow-up | 104 pass, 1 failed | gdctx `2026-10-08T10-18-21-560Z-ccc9e2_run`; both stale audits now pass |

The one remaining failure is `finding 17: the real buildShellHookRuntime denies a
real shell_exec call via a real gate hook script` in `agent-lifecycle-hooks.test.ts`.
It expects the sandboxed script's stderr but receives `hook-crashed`. Independent
launcher reproduction returns `sandbox-exec: sandbox_apply: Operation not permitted`
(exit 71; gdctx `2026-10-08T10-18-11-160Z-6a34c3_run`). This is a failed check in
this environment, not a pass or skip. The test remains unchanged. Rerun it in an
environment that allows the sandbox launcher. Three real-PTY tests were skipped
by their existing opt-in guard; no live terminal or real network recovery was run.

The focused successful regression command was:

```bash
bun test src/harness/provider/ src/commands/agent.recovery.test.ts src/commands/agent.test.ts src/commands/agent.overflow-retry.test.ts src/commands/agent.error-hint.test.ts src/commands/agent-tool-call-budget.test.ts src/commands/agent.context-guard.test.ts src/commands/shell-agent-repl.test.ts src/commands/shell.test.ts src/tui/tui-shell.test.ts src/tui/foreground-operation.test.ts src/tui/turn-guard-shell-wiring.test.ts src/tui/task-cost-shell-wiring.test.ts src/tui/routing-classifier-shell-wiring.test.ts
```

Commands were run through `rtk proxy keryx ctx run --`; summaries and raw output
are under `.metaproject/data/gdctx/artifacts/` and `raw/` using the evidence ids above.

## Acceptance criterion evidence

| AC | Evidence and limits |
|---|---|
| AC1 | Real readline REPL emits one turn_start and no early turn_end while waiting; completes without another prompt. Real headless OpenTUI IO renders recovery and a fresh successful answer; one original user message. |
| AC2 | Scripted 18-failure outage succeeds on attempt 19 with maxRounds=1. Injected wait/random assert jitter and delay cap. Retry-After minimum/cap/NaN tests and real OpenAI adapter 503 HTTP-date test pass. Defaults documented. |
| AC3 | Provisional text/reasoning/replay are absent from checkpoint snapshots and retried messages. Failed thought blocks are not retained. Plain EOF, completed-tool-args EOF and native adapter truncated SSE recover. Interrupted output/reset verified. |
| AC4 | Complete arguments followed by error or EOF invoke no tool. Prior successful write invokes/approves exactly once; following error retries with identical tool-result history. Recovery never wraps tool execution itself. Unknown external effects remain outside exactly-once guarantees. |
| AC5 | Production abortable wait, cancellation immediately before retry and mid-output tests pass. Readline injected lease loss cancels. Foreground owner refuses concurrent begin and queued work waits until settlement. Session switch/lease cancellation is wired in TUI; existing rewind active-turn refusal retained. Full live switch/rewind/lease-loss race in the launched TUI was not run, so this criterion is not fully certified. |
| AC6 | maxRounds=1 survives long outage; prior tools/approval are preserved. Failed/successful usage both forwarded; unknown usage explicit. Injected spend ceiling prevents another request. Existing tool-call-budget regressions pass; context-overflow retry remains bounded across an intervening transport failure. No new default monetary ceiling is claimed. |
| AC7 | Generic 403 authentication/invalid_request/unknown fixtures do not retry even when retryable is incorrectly true; access guidance asserted. Explicit temporary unavailable-403 fixture retries. Provider suite includes existing credential-refresh/auth boundaries. No live entitlement-policy test. |
| AC8 | Readline events prove no success-looking end during recovery; stopped outcome carries errorMessage. Headless OpenTUI frame shows recovering/interrupted/final output and rejects failed reasoning retention. Foreground remains occupied; shipped chrome maps recovering status to running. Next-probe delay is shown, not a continuously repainting countdown. No live PTY responsiveness check. |
| AC9 | 26 deterministic recovery tests plus real readline and headless renderer tests; no real network. 949 focused regressions pass. The broader sandbox-hook failure and three skipped PTY checks mean a blanket all-regressions-green claim is not made. |
| AC10 | README and docs/docs/shell-recovery.md explain policy, defaults, permanent errors, unknown usage/effects and process boundaries. Tests prove absent opt-in, unattended and subagent calls do not recover; TUI side-worker call site is unchanged. |

## Remaining review/verification work

- T4 review/PR/git handling belongs to the main agent. No review approval or AC confirmation is asserted.
- Rerun the sandboxed hook check outside the restrictive parent sandbox.
- Full launched-TUI session switch/rewind/lease-loss races and real PTY responsiveness were not exercised; current evidence is deterministic/headless plus production wiring inspection.
- Long recovery can incur provider charges. Usage that was never reported cannot be measured or enforced as known spend; the host request-admission callback can enforce a separately configured ceiling.
- Visible partial text can remain above the interrupted marker; recovery reissues a model request from completed history, not a remote byte-stream continuation.

## Routing audit

- graph_used: `keryx gdgraph affected src/commands/agent.ts`; initially unavailable,
  then `keryx gdgraph build` and affected query succeeded; rebuilt after adding files.
- wiki_used: `.metaproject/wiki/index.md` for architectural orientation.
- ctx_used: `keryx ctx rg`, read, run throughout; raw command evidence retained locally.
- memory_used: `keryx memory search "shell retry"`.
- testing_used: testing context and `keryx test related src/commands/agent.ts`; focused Bun runs through gdctx.
- raw_rg_used: no.
