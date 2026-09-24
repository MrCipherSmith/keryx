# Implementation Plan

Status: active

## Approach

Straight rename-and-rewrite across ten independent agent identities. Split
the ten renames into two parallel implement batches of five (batch A:
architect, planner, code-explorer, tdd-guide, refactor-cleaner; batch B:
silent-failure-hunter, doc-updater, security-reviewer, performance-reviewer,
e2e-runner) so two sonnet workers can run concurrently without touching the
same files (each old name's reference set is disjoint per the context.md
search). Each worker: `git mv` the agent file, edit frontmatter `name:` and
rewrite description/body prose in its own words, then update every
reference file for its five names found via `keryx ctx rg -i -l`.

Shared files both batches must touch (`docs/docs/guides/agent-catalog.md`,
`W2-agent-catalog.md`, `implementation-plan.md` if present) are split by
row/section ownership per batch to avoid a merge conflict; orchestrator
does the final commit per batch so any overlap is caught at commit time.

## Steps

1. T1 (context) — done by orchestrator directly: rename map, per-name file
   inventory (above), confirmed no other agent-name occurrences hidden
   under `.metaproject/skills` outside flow/review history.
2. T2 (implement, batch A) — sonnet worker renames architect, planner,
   code-explorer, tdd-guide, refactor-cleaner and all their references.
3. T3 (implement, batch B) — sonnet worker renames silent-failure-hunter,
   doc-updater, security-reviewer, performance-reviewer, e2e-runner and all
   their references.
4. T4 (test) — run `bun ./src/cli.ts agents verify`,
   `bun ./src/cli.ts integrations matrix --check`, targeted tests for
   `src/agents`, `src/commands/agents*`,
   `src/gdskills/agent-catalogue-xref.test.ts`, `src/security/audit-harness`,
   `check:doc-links`, and a final exhaustive `keryx ctx rg -i` sweep for
   every old name across `src/` `docs/` `fixtures/` excluding flow/review
   history.
5. T5 (review) — opus adversarial review of the PR diff; fix loop per the
   flow-runner template; open PR against `feat/agent-platform-expansion`,
   get it green, merge.

## Risks

- `architect`/`planner` false positives (common words) — mitigated by
  narrowing to reference-position patterns per context.md, not a blind
  replace-all.
- Two parallel workers editing the same shared doc file — mitigated by
  splitting ownership of shared files' relevant rows/sections per batch and
  committing each batch's changed-file list separately at the task
  boundary (never `git add -A`).
- Missed cross-reference (e.g. a fixture/snapshot) — mitigated by T4's
  exhaustive final sweep.
