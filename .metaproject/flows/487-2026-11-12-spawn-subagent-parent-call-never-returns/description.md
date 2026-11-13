# spawn_subagent parent call never returns after all child subagents complete; timeout_ms does not fire

Status: draft (flow-init skill formalizes this)
Source: user bug report (keryx v0.4.26, session 7418d3f7 / dir 6cdcae93-e730-4f85-a4e5-b4bc7418d3f7, pid 7588, macOS 15.7.2 arm64, branch refactor/primary-command-words, trust mode, anthropic/claude-sonnet-5-5)

## Problem

During an adaptive review (review-orchestrator, PR #8691, 19 reviewers) the parent issued a wave w2 of 9 parallel `spawn_subagent` calls in one message (`timeout_ms` 300000, `mode` read_only, each with `save_result_to`). All 9 children finished (last model call 07:18:12.578 UTC, ~80 s after start), but the parent's `spawn_subagent` call stayed `running` for 2h16m+: no result was delivered to the session and the 300 s `timeout_ms` never fired. Process idle in the event loop (main thread ~95% in kevent64, CPU 0-4%, no TCP sockets, only MCP unix sockets/children). The turn only ends by Esc/kill. Wave w1 (19 reviewers in two batches) in the same session completed normally. The session was ~2 h old, 106 trail steps.

Evidence:
- routing journal `~/.local/share/keryx/routing/journal/7ee3335a…jsonl`: 9 dispatch events 07:16:49-50 UTC, all ended; nothing after 07:18:12.578 (no started/interrupted).
- `slate.json` touched 11:18:12 local; `childDispatches` 47 entries, all completed.
- trail: last step 106 (`keryx review next … r02`); no `spawn_subagent` steps for w2 recorded (calls never completed).
- UI: 9 auto-approved spawn_subagent rows without output + one running `spawn_subagent(label=code-boss-reviewer-w2)`; Subagents counter 0/47 · 4 failed (the 4 failed are from earlier runs).
- Excluded by reporter: memory (468 MB RSS), rate limit/API wait, slot exhaustion by failed subagents, budget ($3.18).

Initial code observation (to be verified): `src/harness/tool/builtin/spawn-subagent-tool.ts` already wraps `invoke` in `invokeWithBackstop` (hard cap = child deadline + 3 min grace, about 8 min for 300000 ms), see the factory wrapper near line 2906. A hang inside `invoke` should therefore have returned a `Timeout` result. So either (a) the hang is OUTSIDE the wrapped `invoke` (tool executor for a parallel batch, approval/hook/trust handling, result delivery/Promise.all in the agent loop, TUI/fleet bridge), or (b) the installed v0.4.26 predates the backstop, or (c) the backstop timer/abort path itself is not reached for this path (e.g. external/other branch with cap 0, or a `finally`/dispose that never settles). Root cause is not yet established.

## Expected Outcome

- After all children of a parallel `spawn_subagent` batch have finished, the parent receives every result and the turn continues.
- If a call does not settle, it returns an error/Timeout result within a bounded time (child deadline + grace) regardless of where the delivery was lost, and the parent turn does not hang indefinitely; results already saved via `save_result_to` remain recoverable.
- Root cause of the lost delivery is identified and fixed, with a regression test that reproduces a lost/hung child result inside a parallel batch.

## Outcome criteria

- A parallel batch of N `spawn_subagent` calls in which one call's result delivery is lost/hangs returns to the parent within the bounded time with a Timeout error for that call and normal results for the others (covered by an automated regression test).
- not measured in production — the hang was seen once and has no reliable reproduction.

## Out of Scope

- Review-orchestrator wave sizing/policy (the "use smaller waves" workaround).
- Machine swap pressure / memory tuning on the reporter's host.
- UI redesign of the Subagents counter (only fix it if it is a direct consequence of the root cause).
