# gdskills

## Purpose

Native bundled Metaproject working skills and orchestrators.

## Install Profile

`recommended`

## Installed Skills

### core

- `context-router`: Choose between gdgraph, gdctx, gdwiki, memory, health, and project-skills before raw file reads.
- `entity-skill-creator`: Create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.
- `entity-skill-learner`: Update project-skills from review findings, test failures, health reports, memory entries, and verifier reports.
- `entity-skill-router`: Select relevant project-skills for known modules, components, stores, services, and domain entities.
- `entity-skill-verifier`: Verify project-skills against current code, graph, wiki, health, memory, tests, and review lessons.
- `metaproject-router`: Choose which Metaproject module, working skill, or project-skill should be used for a user request.

### orchestration

- `code-verifier`: Run and summarize verification gates: typecheck, lint, tests, build, imports, and changed-scope checks.
- `context-collector`: Build compact task context from graph, ctx, wiki, memory, health, project-skills, and selected files.
- `feature-analyzer`: Analyze a feature, module, branch, or migration area and produce an implementation map.
- `job-orchestrator`: Run full task pipelines: clarify, collect context, plan, implement, verify, review, and summarize.
- `task-implementer`: Implement one atomic task end to end using local project context and verification.

### planning

- `brainstorm`: Explore architecture, product, or implementation options with trade-offs and recommendation.
- `interviewer`: Ask focused clarification questions before expensive or ambiguous work.
- `prd-creator`: Convert vague requests into structured PRD and acceptance criteria.

### platform

- `agent-entrypoint-manager`: Maintain AGENTS.md, CLAUDE.md, and local-first Metaproject references.
- `hook-manager`: Create and verify lightweight git hooks for graph, health, and skill verification.
- `skill-catalog-manager`: Generate `.metaproject/skills/catalog.md` and machine-readable skill registry.

### quality

- `test-gen`: Generate tests for a file or module using local patterns and existing test stack.

### review

- `review-architecture`: Review boundaries, dependency direction, layering, and abstraction stability.
- `review-logic`: Review logic correctness, contracts, edge cases, nullability, and async behavior.
- `review-orchestrator`: Route review requests to specialized reviewers and consolidate findings.
- `review-strict`: Perform a strict meta-review over findings, weak assumptions, and residual risk.
- `review-style`: Review naming, readability, duplication, dead code, and maintainability.

## Commands

- `gd-metapro skills status`
- `gd-metapro skills catalog --profile recommended`
- `gd-metapro skills install --profile recommended`

## Storage

- `skills/gdskills/` - installed working skills.
- `project-skills/` - generated entity/project skills.
- `data/gdskills/` - reports, proposals, and artifacts.
