# Context

Collected deterministically by `keryx flow init` at 2026-08-22T11:00:44.254Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Source Issue

https://github.com/MrCipherSmith/keryx/issues/389

### /goal --auto: T10 verifier pass is silent on success — no observable confirmation it ran

## Summary

`/goal --auto`'s T10 verifier pass (SLATE-27, flow 186 — "before the final stop, dispatches one independent `spawn_subagent` verifier call that checks the claimed outcome against the repository") leaves **zero observable trace** when it succeeds or is unavailable. There is no way — from the CLI/TUI output or from the persisted session transcript — to distinguish "the verifier ran and approved the outcome" from "the verifier silently no-opped" (no `spawn_subagent` tool wired in, dispatch error, unparseable verdict — all documented as returning `undefined`).

## Root cause

`runGoalVerifier` (`src/commands/goal-command.ts:379`) dispatches by calling `tool.invoke({ task, mode: "read_only", label: "goal-verifier" })` **directly** on the `spawn_subagent` tool instance, bypassing the normal assistant tool-call loop (`runAgentTurnCore`/`executeCall` in `src/commands/agent.ts`) entirely:

```ts
result = await tool.invoke({ task, mode: "read_only", label: "goal-verifier" });
```

Because it never goes through `executeCall`, none of the usual visibility hooks fire:
- `io.onToolCall` / `io.onToolResult` never fire → no `⚙ spawn_subagent(...)` line in the TUI/CLI.
- Nothing is pushed to `history` → **the call and its verdict are absent from the session's `transcript.jsonl`**.

The only user-visible signal anywhere in `runGoalCommand` is the `!verdict.achieved` branch (`goal-command.ts:619-625`), which prints a `systemLine`. The success path (`verdict.achieved === true`) and the degraded path (`verdict === undefined`, e.g. verifier tool absent or dispatch failed) are both completely silent — same observable behavior for "verified and approved" and "never actually verified."

## Repro

1. `keryx shell --provider deepseek` (or any provider with `spawn_subagent` wired into `deps.tools`), in a project with no bound flow.
2. `/goal <a small, genuinely-completable, read-only task> --auto 1`
3. Watch the transcript: round 1 runs, round 2 (continuation) runs, the turn ends with a normal final answer. No `⚙ spawn_subagent(...)` line ever appears.
4. Inspect the session's `transcript.jsonl` (`~/.local/share/keryx/sessions/<project>/<session-id>/transcript.jsonl`): no `toolCalls` entry named `spawn_subagent` anywhere, despite T10's own doc comment describing this as something that always runs before the final stop.

Confirmed live against a real DeepSeek-backed session (auto-provisioned Flow 188, `workspace-5c74a3f7b3c7414b`) while testing the 0.2.53 release.

## Why this matters

The verifier is the feature's core selling point per the CHANGELOG — "instead of trusting the model's own 'I'm done.'" An operator (or an automated audit of a `--auto` run) currently has no way to confirm that safety check actually executed, which undermines the trust the feature is meant to establish. A silently-unavailable verifier (e.g. `spawn_subagent` not wired into `deps.tools` for a given shell configuration) is indistinguishable from a verifier that ran and approved.

## Suggested direction (not prescriptive)

- Route the verifier dispatch through the same visibility path as any other tool call (`io.onToolCall`/`io.onToolResult`), or at minimum emit a `systemLine` on every outcome, not just the "not achieved" branch — e.g. `/goal --auto: verifier confirmed the goal is achieved` vs `/goal --auto: verifier unavailable — outcome not independently checked`.
- Persist the verifier's dispatch + verdict into `history`/the transcript so a resumed/exported session shows whether T10 actually ran.

## Environment

- `keryx 0.2.55` (npm `@mrciphersmith/keryx`)
- Provider: `deepseek/deepseek-chat`
- macOS

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

_(flow-init skill appends here)_
