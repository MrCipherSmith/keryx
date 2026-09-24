# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: All ten bundled agent files are renamed (`git mv`) with `name:` frontmatter and prose updated to the new Keryx-own names; old filenames no longer exist under `src/gdskills/bundled/agents/`.
- AC2: `bun ./src/cli.ts agents verify` passes for all ten new agent names.
- AC3: `bun ./src/cli.ts integrations matrix --check` passes.
- AC4: Targeted tests pass: `src/agents/**`, `src/commands/agents-catalog-commands.test.ts`, `src/gdskills/agent-catalogue-xref.test.ts`, `src/security/audit-harness` (agent-enumerating tests).
- AC5: `docs/docs/guides/agent-catalog.md`, `docs/docs/cli-reference.md`, and `docs/requirements/keryx-agent-platform-expansion/workstreams/W2-agent-catalog.md` (catalog table + version bump) reflect only the new names; `check:doc-links` passes.
- AC6: A final `keryx ctx rg -i "<old-name>"` sweep over `src/`, `docs/`, and fixtures for each of the ten old names returns no hits outside `.metaproject/flows` history and past review records.
- AC7: PR opened against `feat/agent-platform-expansion`, reviewed (opus round), CI green, and merged.
