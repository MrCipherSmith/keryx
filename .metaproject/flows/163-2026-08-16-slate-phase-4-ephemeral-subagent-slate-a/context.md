# Context

Collected deterministically by `keryx flow init` at 2026-08-16T18:53:47.351Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

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

**Base branch**: `main` (git worktree `keryx-wt-slate-phase4` on branch
`feat/slate-phase4`, branched from `origin/main`). The PR for this flow must
merge into `main`.

**Prior phases (reference, all merged)**: flow 157 (PR #297, Phase 1
skeleton + bundled SAC hardening), flow 160 (PR #301, Phase 2 Anchors/
Course/Seeds + unattended checkpoint), flow 161 (PR #304, Phase 3 `/goal`
consult surface + deterministic entry).

**Key files read in full**: `docs/requirements/slate/specification.md`,
`docs/requirements/slate/agent-protocol.md`, `src/session/slate.ts`,
`src/session/slate-lifecycle.ts`, `src/session/slate-course.ts`,
`src/session/slate-terminal-state.ts`, `src/sac/proposal-lifecycle.ts`,
`src/sac/trusted-wrap-up.ts`, `src/harness/provider/single-turn.ts`,
`src/harness/tool/builtin/spawn-subagent-tool.ts`,
`src/commands/goal-command.ts`. Targeted sections (via `keryx ctx rg`/`Read`
with offsets — not full reads) of `src/commands/agent.ts` (slate open/close
trigger wiring ~660-940, terminal-state emission), `src/commands/harness.ts`
(`ParsedArgs`/`parseArgs` ~237-353, `run` subcommand body ~369-540),
`src/commands/workspace.ts` (`propose`/`review` CLI handlers).

**Confirmed gaps this flow closes**:
- `spawn-subagent-tool.ts` never touches `slate.json`; the child system
  prompt (line ~257-260) is a hardcoded string with zero Anchors-equivalent.
- `trusted-wrap-up.ts`'s `resolveExplicitWrapUp` composition in
  `createHarnessProposalLifecycleService` (`proposal-lifecycle.ts:436-439`)
  throws for any `request.source !== "session"` — the `"flow"` case (SLATE-7)
  does not exist anywhere.
- `keryx harness run`'s `--goal`/`--unattended`/`--workspace` flags are
  parsed and stored (Phase 3) but the `run` subcommand body still calls
  `runOffline` with an empty `ToolRegistry`/`denyingExecutor` — no slate is
  ever opened on this path today, confirmed by reading the full body
  (`src/commands/harness.ts:369-540`). AC8 is scoped to the wrap-up *trigger*
  firing at process termination on this path (and never on the REPL path),
  not to making this runner fully tool-capable (see description.md's Out of
  Scope).

**Reusable patterns found** (avoid inventing parallel mechanisms):
- `workspace.ts`'s `propose` subcommand (~93-118) is the canonical
  `wrapUpAuthority.issue({ source, sourceRef }) → service.create(...)`
  sequence; Track B's composer mirrors it for `source: "flow"`.
- `resolveWorkspaceForActor` (`src/sac/workspace-service.ts:397`) is the
  fail-closed `--workspace` validator already used by both `/goal` and
  `harness run --workspace`.
- `spawn-subagent-tool.ts` already has a wall-clock deadline race
  (`Promise.race` + `setTimeout`, ~330-379) — Track B's model-summary
  timeout fallback should mirror this exact shape, including the
  `void turn.catch(() => {})` abandoned-promise handling.
- `ProposalLifecycleService.create()` (`proposal-lifecycle.ts:103-119`)
  already throws `conflict` for a second write to the same proposal path
  inside the same file lock the write uses — this is the mechanism Track B's
  AC4 dedup plan relies on (deterministic proposal id), not a new lock.
