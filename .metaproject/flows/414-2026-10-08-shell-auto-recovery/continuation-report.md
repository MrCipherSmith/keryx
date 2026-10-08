# Flow 414 continuation report — independent-review blockers

Date: 2026-10-08. Worktree: `/Users/tsaitler.aleksandr/goodea/keryx/.worktrees/shell-auto-recovery`.

Both reported blockers are repaired in this worktree. No commit, push, rebase,
merge, tag, release, stash, PR publication, or other-worktree edit was performed.
Flow 414 remains in-progress, T4 open, with zero AC confirmations. These changes
require independent review; this report does not certify the frozen AC.

## Changes and evidence

1. **Body-read transport failure:** moved the existing agent transport recognizer
   to provider-port and shared it across native OpenAI, Anthropic, Gemini and
   OpenAI-compatible SSE read catches. Recognized non-abort socket/network failures
   emit retryable unavailable with incompleteStream. Aborts remain cancelled;
   unrecognized/parser/programming failures remain non-retryable malformed.
   Fetch negatives retain their existing unavailable classification; HTTP error
   body parsing retains the HTTP status classification, so a failed error-body
   parse cannot turn authentication into an endless transport retry. Timeout,
   parser, terminal provider error and EOF branches were inspected. OpenAI Codex
   and Ollama wrappers have no separate reader catch to repair.
2. **Real native adapter recovery fixture:** the injected fetch returns a real
   ReadableStream: first chunk contains partial text and a completed function-call
   argument event, next pull errors with a nested ECONNRESET, next request returns
   a successful native Responses SSE stream. Test proves two requests/one user
   turn, a single recovery delay, a provisional tool_call_end actually emitted,
   zero tool execution, no provisional checkpoints/retry history, and a completed
   recovered answer. No real network or live TCP connection is used.
3. **Session lifetime:** session invalidation immediately revokes foreground IO
   acceptance but leaves the owner active until settlement. /new, /clear and
   /resume use the invalidation boundary before replacing liveSession. Ordinary
   cancellation retains acceptance so stopped still renders. The main finalizer
   checks acceptance before settlement and returns before completion, checkpoint,
   remote reply, cost/guard side effects and queue/wake dispatch for an invalid
   session. Stale routing preparation exits before archive/rewind bookkeeping;
   direct compaction callbacks are also guarded. Session switch resets streaming
   and live reasoning, cancels suggestions and pending checkpoint timers, clears
   old Force selections, and invalidates pending settlement handoffs by generation.
4. **Regression guards:** real runAgentTurn plus the production foreground facade
   and settlement helper simulate a session replacement during backoff and a
   delayed stream. They assert no late output/completion/persistence/queue drain
   into the replacement, while concurrent begin remains refused until settlement.
   Cancellation/Force lifecycle tests cover stopped and fresh handoffs. Source
   wiring checks bind these tested primitives to both session switch sites and
   the production finalizer. Two pre-existing source audits needed their finalizer
   anchor updated after the new early stale-preparation settlement branch.
5. **Readline accounting:** latest request usage remains available to context
   inspection. Separate turn usage sums reported input/output/total/cache counts
   across failed and successful requests for turn_end and the printed turn total.
   The real REPL test verifies both attempts, cache subsets, unchanged individual
   usage events and reset on the next operator turn. Unknown/unreported charges
   remain unknown; this does not add billing estimates or a new spend ceiling.

## Exact verification commands

All commands below ran from this worktree through `rtk proxy keryx ctx run --`.
Evidence ids identify `.metaproject/data/gdctx/artifacts/<id>.md` and
`.metaproject/data/gdctx/raw/<id>.log`. Logs retain failed runs as well as passes.

```bash
rtk proxy keryx ctx run -- bun test src/commands/agent.recovery.test.ts src/tui/foreground-operation.test.ts src/harness/provider/stream-contract.test.ts src/tui/routing-classifier-shell-wiring.test.ts
rtk proxy keryx ctx run -- bun test src/commands/shell-agent-repl.test.ts -t 'readline recovery|readline shutdown|readline lease loss|readline turn totals'
rtk proxy keryx ctx run -- bun run typecheck
rtk proxy keryx ctx run -- bun run typecheck:scripts
rtk proxy keryx ctx run -- bunx eslint src/commands/agent.ts src/commands/shell-agent-repl.test.ts src/commands/shell-bus.test.ts src/commands/shell.test.ts src/commands/shell.ts src/harness/provider/anthropic/anthropic-provider.ts src/harness/provider/compat/openai-compat-provider.ts src/harness/provider/gemini/gemini-provider.ts src/harness/provider/openai/openai-provider.ts src/harness/provider/provider-port.test.ts src/harness/provider/provider-port.ts src/harness/provider/stream-contract.test.ts src/harness/provider/types.ts src/tui/foreground-operation.test.ts src/tui/foreground-operation.ts src/tui/routing-classifier-shell-wiring.test.ts src/tui/tui-shell.test.ts src/tui/tui-shell.ts src/commands/agent.recovery.test.ts
rtk proxy keryx ctx run -- bunx eslint src/commands/shell.ts src/tui/tui-shell.ts
rtk proxy git diff --check
```

| Check | Result | Evidence id |
|---|---|---|
| Adapter/recovery/ownership/routing fixtures | 79 pass, 0 fail, 310 assertions | 2026-10-08T10-36-46-503Z-64be47_run |
| Final readline recovery/accounting subset | 4 pass, 0 fail; 50 filtered | 2026-10-08T10-39-50-669Z-7839e0_run |
| Final main typecheck | Pass, exit 0 | 2026-10-08T10-41-35-629Z-51495b_run |
| Scripts typecheck | Pass | 2026-10-08T10-34-45-622Z-a1b9af_run |
| All 19 changed TypeScript paths | ESLint pass; final shell/TUI repeat also pass | 2026-10-08T10-38-05-165Z-280e11_run; 2026-10-08T10-40-44-733Z-5a6e59_run |
| Whitespace | Pass (no output) | direct git diff --check; also 2026-10-08T10-35-47-384Z-9b8dd0_run |

## Broader runs and failed checks

The broader final sweep command was:

```bash
rtk proxy keryx ctx run -- bun test --timeout 20000 src/harness/provider/ src/commands/agent.recovery.test.ts src/commands/agent.test.ts src/commands/agent.overflow-retry.test.ts src/commands/agent.error-hint.test.ts src/commands/agent-tool-call-budget.test.ts src/commands/agent.context-guard.test.ts src/commands/shell-agent-repl.test.ts src/commands/shell.test.ts src/commands/shell-bus.test.ts src/tui/tui-shell.test.ts src/tui/foreground-operation.test.ts src/tui/turn-guard-shell-wiring.test.ts src/tui/task-cost-shell-wiring.test.ts src/tui/routing-classifier-shell-wiring.test.ts
```

**1014 pass, 1 fail, 44 files**; `2026-10-08T10-38-22-595Z-cf07bb_run`.
The failure was the existing shellCommand makeAgentDeps/getSessionDir test,
which exceeded 20s. Its isolated follow-up passed:

```bash
rtk proxy keryx ctx run -- bun test --timeout 20000 src/commands/shell.test.ts -t 'makeAgentDeps threads a supplied'
```

1 pass, 0 fail; `2026-10-08T10-39-09-520Z-f4ccff_run`.
An initial mistakenly scoped invocation against shell-bus.test.ts matched zero
tests and exited 1 (`2026-10-08T10-38-51-249Z-4fd754_run`); it is not validation.

A separate final shell/OpenTUI sweep ran:

```bash
rtk proxy keryx ctx run -- bun test --timeout 20000 src/commands/shell-agent-repl.test.ts src/tui/tui-shell.test.ts src/tui/routing-classifier-shell-wiring.test.ts
rtk proxy keryx ctx run -- bun test --timeout 20000 src/commands/shell-agent-repl.test.ts -t 'consecutive auto-wakes'
```

229 pass, 1 fail (`2026-10-08T10-39-08-879Z-a94574_run`); the existing consecutive
completion-wake test failed its own 5s wait for the cap notice. The isolated
follow-up also failed that wait (`2026-10-08T10-39-55-184Z-993e6f_run`). It had passed
in the earlier 95-test focused run (`2026-10-08T10-31-04-687Z-4fb6b0_run`) and in the
1014-pass sweep. Root cause was not established; the failure remains a limitation,
not a claimed pass or proven environmental failure. That test was not weakened.

Other intermediate failures retained in logs: two stale finalizer source-audit
anchors (corrected), fixture typing errors (corrected; later typecheck passes),
and default-5s shell/beforeEach timeouts. In particular the 1013-pass/2-fail sweep
was `2026-10-08T10-34-16-985Z-64c673_run`; the 721-pass/2-fail sweep was
`2026-10-08T10-31-46-892Z-660f4e_run`; the 97-pass/1-fail and 53-pass/1-fail readline
runs were `2026-10-08T10-35-12-223Z-b04656_run` and
`2026-10-08T10-37-10-460Z-48e9b8_run`. No blanket all-regressions-green claim is made.

## Limitations and flow state

- No independent review approval, AC certification, PR or git publication.
- Full launched TUI /new and /resume are not mounted end-to-end in these tests.
  Session replacement is exercised through real agent execution and production
  ownership/IO/finalization primitives; production call sites are source audited.
  Existing real headless OpenTUI rendering tests pass in the combined runs.
- No real TCP/network outage, live terminal/PTY responsiveness, real-provider
  billing, or live entitlement test. No guarantee for already-started external
  tool effects is added.
- The previous handoff's sandbox hook failure and skipped real-PTY checks were
  not rerun here and remain documented there.
- Worktree contained the earlier implementation and an existing untracked
  `.recovery-implementation-report.txt` before this continuation; preserved.

## Routing audit

- graph_used: gdgraph affected foreground-operation; initial graph stale. Ran
  `rtk proxy keryx ctx run -- keryx gdgraph build` successfully (2888 nodes,
  10115 edges; `2026-10-08T10-38-26-987Z-86f1d3_run`). Tracked graph artifact bytes
  were preserved/restored to avoid unrelated changes; a later affected query
  still warns about restored artifact freshness, so graph output was navigation
  only and every conclusion was checked in current source.
- wiki_used: .metaproject/wiki/index.md for architecture orientation.
- ctx_used: routed searches and verification commands; summaries/raw logs retained.
- memory_used: keryx memory search 'shell retry'.
- testing_used: testing skill/context and related tests for native OpenAI.
- raw_rg_used: no.
