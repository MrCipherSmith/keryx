# Context

Collected deterministically by `keryx flow init` at 2026-08-11T21:06:19.633Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`

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

## Agent Findings

_(flow-init skill appends here)_
## SAC Phase 1 context

- Phase 0 `src/sac/index.ts` is the contract authority: runtime Draft 2020-12
  validation, semantic checks, reference realpath containment, trusted
  `ActorContext`, revalidation and strict-guard eligibility already exist.
- `src/lib/file-lock.ts` is the repository's exclusive lock primitive. It
  protects read-modify-write; atomic rename alone prevents torn files only.
- Normative workspace data remains the single `workspace.json` primary record;
  no derived receipts or source-module content belong in this phase.
- Requirements: specification AC-1 / AC-7 mutation portion / AC-10, agent
  protocol local identity boundary, artifact lifecycle storage isolation.
- Wiki used: Project Map, src/flow, src/harness, src/mcp, src/security indexes;
  all are owners excluded from Phase 1 runtime changes.
- Memory: review fixes need a fresh review pass; flow ids are common-clone
  allocated (this Flow is 146).
