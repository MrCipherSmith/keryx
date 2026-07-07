# Context

Collected deterministically by `gd-metapro flow init` at 2026-07-07T12:00:08.216Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `gd-metapro gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-07T11:37:55.352Z)
- refresh: `gd-metapro health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki

## Agent Findings

_(flow-init skill appends here)_
# Context

## Relevant Existing Files

- `src/commands/init.ts` currently discovers root `AGENTS.md`/`CLAUDE.md`,
  appends the managed Metaproject reference block, and writes imported rule
  mirrors into `.metaproject/rules`.
- `src/commands/update.ts` has a second local `syncAgentRules` implementation
  with similar behavior.
- `src/lib/templates.ts` renders `.metaproject/index.md`,
  `.metaproject/rules/README.md`, imported rule files, and the project-rules
  skill README.
- `src/cli.ts` owns top-level command routing and help text.
- Existing tests in `src/commands/init.test.ts` and
  `src/commands/update.test.ts` cover entrypoint migration indirectly.

## Current Behavior

- Imported rules are plain Markdown mirrors with no frontmatter metadata.
- Index rules table has no priority column.
- There is no `gd-metapro rules sync` command.
- `update.ts` imports `ensureMetaprojectReference` from `init.ts`, coupling
  update behavior to init internals.

## Design Constraints

- Keep root entrypoint files as the source of truth for root-level instructions.
- Do not load or duplicate external/global skill sets.
- Keep generated Metaproject data and service files separate.
- Do not edit flow state by hand; use flow CLI for status changes.
