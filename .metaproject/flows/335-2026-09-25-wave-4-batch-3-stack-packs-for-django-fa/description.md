# Wave 4 batch 3: stack packs for django, fastapi, rust, java-kotlin-spring

Status: in-progress
Source: user description

## Problem

`docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md`'s
target-stack table lists 23 stacks; batches 1 and 2 (flows 314/316/317/318)
delivered ts-js-node, react, python, go, nestjs, angular, mobx. Four more
stacks in the table have no pack at all today: `django`, `fastapi`, `rust`,
`java-kotlin-spring`. Each ships as "review-only or absent" — no
implementation/test/build-fix skill, no stack-scoped rules — leaving Keryx
without stack-aware coverage for two of the most common Python web
frameworks, Rust, and JVM (Java/Kotlin + Spring).

## Expected Outcome

- Four new stack packs under `src/gdskills/bundled/stacks/<id>/` (`django`,
  `fastapi` extending `python`; `rust` as its own language pack;
  `java-kotlin-spring` as its own framework-family pack), each with
  `pack.json`, `agent-refs.json`, `rules/*.mdc` (`extends: common`, scoped
  `paths:`), and only the skill categories genuinely distinct from the
  existing catalog, each skill with judge-format `evals.json` (calibration:
  `known_right`/`known_wrong`/`vague`/`subtle_wrong`) per
  `docs/docs/guides/write-a-rubric-scenario.md`.
- `src/gdskills/bundled/install-manifest.json` wired with modules/components/
  profiles for all four packs (Phase A: authoring + offline checks only).
- Phase B (after #719 and flow 334 merge, orchestrator go-ahead): rebase,
  run calibration + honest DeepSeek gate, derive stability/agents from real
  gate results, open PR into `main`, adversarial review, CI green, merge.

## Out of Scope

- Any stack outside django/fastapi/rust/java-kotlin-spring.
- Editing existing batch-1/2 packs' content (ts-js-node, react, python, go,
  nestjs, angular, mobx) beyond what shared-file wiring requires.
- Running the calibration/gate before the orchestrator confirms #719 and
  flow 334 are merged into main.
