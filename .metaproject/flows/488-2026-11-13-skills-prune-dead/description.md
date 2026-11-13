# Prune dead and orphaned bundled skills (stage 1)

Status: formalized
Source: user description (origin: human-request)

## Problem

A relevance audit of the bundled skills (2026-11-13) found skills that nothing can reach:

- seven planning skills (`project-discovery`, `problem-definer`, `stack-advisor`,
  `patterns-researcher`, `spec-writer`, `consistency-checker`, `planner`) are phases of a
  pipeline whose orchestrator is not shipped, together with their contract rule
  `rules/core/gproject-contracts.mdc`;
- `job-documenter` is no longer called by `job-orchestrator`, which uses `keryx job init/document`;
- `feature-dev` is a third end-to-end pipeline with no mechanism of its own;
- seven catalog-rendered stubs (`hook-manager`, `skill-catalog-manager`, `skill-runtime-exporter`,
  `skill-sync`, `context-router`, `entity-skill-router`, `entity-skill-learner`) hold three
  generic bullets and do not name the CLI command they stand for.

They cost routing collisions, lint exemptions, length ceilings and test fixtures, and they
are installed into every user project.

## Expected Outcome

The sixteen skills and the orphaned rule are gone from the shipped set and from this
repository's installed mirror; every registry, test and surviving skill text that named them
is consistent with their absence; a project that already has them installed is handled the
way the repository already handles a retired rule.

## Outcome criteria

- Запрос (дословно): «Да, этап 1» (source: desktop session 2026-11-13, answer to the skills relevance audit)
- Эффект (формализация агента): мёртвые и осиротевшие скилы больше не поставляются и не устанавливаются, а оставшийся набор проходит те же проверки, что и раньше.
- Как наблюдать (предложение агента): каталог скилов не содержит шестнадцати имён; тесты `src/gdskills` и маршрутизации зелёные; typecheck зелёный.

## Out of Scope

- `review-jev-*` skills and the `code-ai-review` / `code-style-review` / `code-mobx-store-review`
  profiles: both are referenced from review source code and need their own decision.
- Rewriting or shrinking any surviving skill beyond removing references to a deleted one.
- Changing the anatomy lint or the length-ceiling policy (stage 2).
