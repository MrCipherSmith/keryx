# Agent catalog: Keryx-own names for the ten bundled agents

Status: active
Source: user description (dispatch from flow-runner template, agent-platform-expansion program)

## Problem

The ten hand-authored bundled agents in `src/gdskills/bundled/agents/*.md`
(`architect`, `planner`, `code-explorer`, `tdd-guide`, `refactor-cleaner`,
`silent-failure-hunter`, `doc-updater`, `security-reviewer`,
`performance-reviewer`, `e2e-runner`) carry names that coincide with an
external third-party agent catalogue. The owner wants Keryx's own designs,
not names that read as copies of someone else's catalogue.

## Expected Outcome

Exact rename, everywhere the old name is a reference to one of these ten
agents (not merely a substring match of a common English word):

- `architect` → `design-advisor`
- `planner` → `work-planner`
- `code-explorer` → `codebase-navigator`
- `tdd-guide` → `test-first-driver`
- `refactor-cleaner` → `refactoring-steward`
- `silent-failure-hunter` → `error-path-auditor`
- `doc-updater` → `docs-maintainer`
- `security-reviewer` → `security-auditor`
- `performance-reviewer` → `performance-auditor`
- `e2e-runner` → `end-to-end-tester`

For each: rename the `.md` file, update its `name:` frontmatter, rewrite the
`description`/body prose in original wording wherever it echoes the old name
(tools/tiers/policy/behavior unchanged), and update every code/test/doc
reference: `src/agents/**` tests, `src/commands/agents-catalog-commands.test.ts`,
`src/gdskills/agent-catalogue-xref.test.ts`, security audit tests that
enumerate agents, `docs/docs/guides/agent-catalog.md`,
`docs/docs/cli-reference.md` examples,
`docs/requirements/keryx-agent-platform-expansion/workstreams/W2-agent-catalog.md`
(catalog table, version bump), and any brainstorm/implementation-plan/README
of that requirements package, fixtures/snapshots, and the W5 capability
matrix if names appear there.

## Out of Scope

- Unrelated skills/reviewers that merely share a word with an old name (e.g.
  skill `review-security-code` stays as-is).
- Any change to agent behavior, tools, tiers, or policy profiles.
- Per-stack generated agent pairs (not part of this ten-agent rename).
