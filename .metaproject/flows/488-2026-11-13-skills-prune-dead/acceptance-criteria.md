# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The nine skill directories (planning: project-discovery, problem-definer, stack-advisor, patterns-researcher, spec-writer, consistency-checker, planner; orchestration: job-documenter, feature-dev) exist neither under `src/gdskills/bundled/skills` nor under `.metaproject/skills/gdskills`, and `gproject-contracts.mdc` exists in neither rules tree. [verify: exec `bash -c 'for r in src/gdskills/bundled/skills .metaproject/skills/gdskills; do for s in planning/project-discovery planning/problem-definer planning/stack-advisor planning/patterns-researcher planning/spec-writer planning/consistency-checker planning/planner orchestration/job-documenter orchestration/feature-dev; do test ! -e $r/$s || exit 1; done; done; test ! -e src/gdskills/bundled/rules/core/gproject-contracts.mdc && test ! -e .metaproject/rules/core/gproject-contracts.mdc'`]
- AC2: None of the sixteen removed skill names is registered in `src/gdskills/catalog.ts` or listed in `.metaproject/skills/catalog.md`. [verify: exec `bash -c '! rg -q -e "\"(project-discovery|problem-definer|stack-advisor|patterns-researcher|spec-writer|consistency-checker|planner|job-documenter|feature-dev|hook-manager|skill-catalog-manager|skill-runtime-exporter|skill-sync|context-router|entity-skill-router|entity-skill-learner)\"" src/gdskills/catalog.ts && ! rg -q -e "(project-discovery|problem-definer|stack-advisor|patterns-researcher|spec-writer|consistency-checker|job-documenter|feature-dev|hook-manager|skill-catalog-manager|skill-runtime-exporter|skill-sync|context-router|entity-skill-router|entity-skill-learner)" .metaproject/skills/catalog.md'`]
- AC3: No surviving bundled skill or rule tells the reader to use a removed skill or the removed rule. [verify: exec `bash -c '! rg -q -e "job-documenter|feature-dev|gproject-contracts|gproject-orchestrator" src/gdskills/bundled/skills src/gdskills/bundled/rules'`]
- AC4: The gdskills and routing test suites pass. [verify: exec `bun test src/gdskills src/commands/skills-route.test.ts src/commands/routing-corpus.test.ts src/commands/routing-baseline.test.ts src/commands/routing.test.ts`]
- AC5: Type check passes. [verify: exec `bun run typecheck`]
- AC6: An existing installation is not left worse off: either the upgrade path removes an unmodified installed copy of a removed skill and of `gproject-contracts.mdc` the same way it already removes a retired rule, or the PR description states that installed copies stay in place and why. [verify: judged]
