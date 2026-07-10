# Context

Collected deterministically by `keryx flow init` at 2026-07-09T18:54:04.810Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-08T10:34:26.644Z)
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

## Agent Findings

- Requirements source of truth:
  `docs/requirements/managed-review-feedback-loop/README.md`,
  `prd.md`, `specification.md`, `agent-protocol.md`,
  `artifact-lifecycle.md`, `metrics-and-validation.md`, and
  `schemas/managed-review-package.schema.json`.
- Task Manager is enabled in `.metaproject/metaproject.json`
  (`modules.tasks.enabled: true`).
- Local CLI stable execution path in this workspace is
  `/path/to/.bun/bin/bun ./src/cli.ts ...`; `keryx` is not on
  PATH in this shell.
- Existing flow state API is in `src/flow/service.ts`,
  `src/flow/types.ts`, `src/commands/flow.ts`; `flow.json` writes go through
  `writeFlow` and service mutations.
- Existing tests to extend or mirror:
  `src/flow/service.test.ts`, `src/flow/machine.test.ts`,
  `src/testing/service.test.ts`, and command tests under `src/commands`.
- Existing review-orchestrator is currently skill-level documentation under
  `.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md` and bundled
  copies under `src/gdskills/bundled/skills/review/review-orchestrator/`.
- No accepted project memory matched "managed review feedback loop review
  orchestrator flow".
- Baseline health is WARN as of 2026-07-08, with existing complexity findings;
  this flow must not claim a green gate without rerunning verification.
- Testing context: Bun project; `bun test`, `bun run check`, and
  `keryx test run --changed` are the preferred local verification surfaces.
