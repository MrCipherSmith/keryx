# Context

Collected deterministically by `keryx flow init` at 2026-08-21T15:04:07.161Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-20T11:53:56.789Z)
- refresh: `keryx health run`

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

**Source research:** `docs/requirements/goal-continuation/competitor-survey.md`
(13-clone survey; see that file's "Conclusions carried into flow 186" for
the summary this flow's plan is built from). Two published Artifacts present
the same findings as a formatted report — English:
`https://claude.ai/code/artifact/b1990fec-64c4-4465-bf92-c1171535531b`,
Russian: `https://claude.ai/code/artifact/217b6f1d-c1de-4712-9cf7-f45a114e67d8`
(both private to the author; not a substitute for the in-repo doc above,
which is the citable source).

**Relevant existing keryx code** (all read directly, not assumed):

- `src/commands/goal-command.ts` — `/goal`'s current one-shot behavior
  (`runGoalCommand`, `parseGoalArgs`). This flow extends `parseGoalArgs`
  and the dispatch sequence, not a rewrite.
- `src/commands/agent.ts`:
  - `runAgentTurn`/`runAgentTurnCore` — the turn loop a continuation round
    re-invokes.
  - `closeSlateOnFlowDone` + `isCourseDone`/`courseFromSlate` — the
    **already-existing**, live-re-derived (never cached) "is the bound flow
    done" check that runs in `runAgentTurn`'s own `finally` block today.
    This is the natural stop-condition to reuse for the continuation loop —
    it already does not trust the model's own narrative, since it reads
    real Task Manager task-completion state.
  - `RunAgentTurnOptions.skipCloseTrigger` — `/goal` already opts out of the
    unrelated close-PHRASE heuristic (`isClosePhrase`,
    `src/session/slate-lifecycle.ts`, matched against the *user's* message
    text, not the model's). Not to be confused with `isCourseDone` above;
    the continuation loop only interacts with the latter.
- `src/session/slate.ts` — `Slate.course.flowRef` (the existing bind point
  between a slate and a Task Manager flow) and `SlateSessionRef` (in-memory,
  per-attempt — the natural home for an armed `--auto` flag, since it
  already does not survive a resume/fork).
- `keryx flow init` / `keryx flow plan <id>` / `keryx flow freeze` /
  `keryx flow start` — CLI surface for auto-provisioning a flow when
  `--auto` is used without one already bound.
- `spawn_subagent` (harness tool, `read_only` mode) — existing dispatch
  mechanism proposed for the single verifier call; no new agent-dispatch
  path needs to be built.
- `resolveApprovalDecision` (`src/commands/permission-mode.ts`) — the
  existing per-tool-call approval gate, explicitly unchanged by this
  proposal (AC6).
