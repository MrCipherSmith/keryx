# Context

Collected deterministically by `keryx flow init` at 2026-09-01T01:24:39.148Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] Theme switch repaints already-rendered chrome via old-slot value matching - `.metaproject/memory/lessons/theme-switch-repaint.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-22T15:31:16.004Z)
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

_(flow-init skill appends here)_

## Established facts (verified in this session, not recalled)

- `flow.json` top-level keys: `acChecksum, acConfirmed, createdAt, gates,
  history, id, pr, schemaVersion, slug, source, status, tasks, title,
  updatedAt`. The `pr` block is `{ "url": null }`. No branch anywhere.
- `keryx ctx rg "baseRefName|base_ref|\.base\b"` filtered to `src/flow/`:
  **zero hits**. Nothing in the flow package reads a base ref.
- The completion gate has five conditions, enumerated at `src/flow/review-gate.ts`.
  None is about the merge target.
- Condition 3's mechanism, from its own comment: containment first, then
  `<round head>^{tree}` against `<merged commit>^{tree}`, with `unobserved` when a
  tree cannot be read. Three outcomes, deliberately not two.

## Where the value already is typed

PR #424 (merged `bfaf3b16`) made `base_branch` a typed property of
`flow-orchestrator-input` and registered the schema, so a dispatch that omits or
empties it is refused by `keryx skills contracts validate`. Inside the package it
then becomes prose: `flow-orchestrator/SKILL.md` Phase 1 tells the agent to record
the base in `context.md` and `journal.md`.

Note the dependency on flow 213: that refusal fires only when an agent runs the
validator. This flow's AC3 does not depend on it — the gate reads the record, and
the record is written by the CLI.

## Prior art to follow

- `src/flow/review-gate.ts` conditions 3 and 4 — the `pass` / `violated` /
  `unobserved` discipline, and the rule that an unobservable condition fails with a
  message naming the tracker rather than the flow. Condition 4's header states the
  reasoning at length; AC4 and AC5 are modelled on it.
- The `collected_sha` history on `PrCommentState` — the same class of defect,
  already fixed once: a counter that could not be dated let `flow complete` pass a
  flow with five unanswered reviewer comments on it while printing `0 outstanding`.

## Where this came from

Round 3 of the review on PR #424, `ARCH F-108`. The reviewer's summary —
"detectable at dispatch time and undetectable at completion time" — is accurate,
but it understates condition 3, which catches the wrong-target merge whenever the
targets' CONTENT differs. The narrower residual is written up in
`description.md`; it is the case where the two targets have converged, which is
also the case `review-pr-feedback --fix` most plausibly produces.
