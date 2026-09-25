# Implementation Plan

Status: in-progress

## Approach

Mirror the batch-1/2 pack shape (`src/gdskills/bundled/stacks/python/`,
`.../go/`) exactly, per the lessons file
(`stack-pack-lessons.md`) and W1's `pack.json`/rule/skill/evals.json layout.
One disjoint pack directory per parallel sonnet worker; only the runner
touches shared files (`install-manifest.json`; `authoring-lint.ts`
`STACK_EXTENSIONS` once it exists post-rebase; W1/W2 docs).

Django and fastapi extend `python` (dependency on `python-rules`/
`python-skills`, `extends: common` + scoped `paths:` in their own rule
files, not literal inheritance of python's rule text). Rust is a standalone
language pack (no extends), same shape as `go`. `java-kotlin-spring` ships
as its own standalone framework-family pack — the spec's `lang:java-kotlin`
base does not exist yet, so it is authored self-contained rather than
invented as a phantom dependency.

## Steps

1. Read templates (`stacks/python/**`, `stacks/go/**`) and the write-a-
   rubric-scenario guide; verify version-specific facts with ctx7 (Django,
   FastAPI, Rust/Cargo, Spring Boot).
2. Dispatch 4 parallel sonnet workers, one per stack, each authoring its own
   `src/gdskills/bundled/stacks/<id>/` directory only: `pack.json`,
   `agent-refs.json`, `rules/*.mdc`, `skills/<name>/SKILL.md` +
   `evals.json` for implement/test/review/build-fix (migrate only if the
   stack genuinely has one — Django does via its migrations framework).
3. Runner wires `install-manifest.json` (profiles + modules + components)
   for all four packs once workers return.
4. Runner runs offline integrity/lint checks (bundled-eval.test.ts and
   siblings; `bun ./src/cli.ts skills verify`/`contracts validate` as
   applicable) and fixes defects.
5. Commit per pack, then the shared-file wiring commit.
6. Push branch, return `STATUS: READY_FOR_GATE`, wait for the orchestrator's
   go-ahead (PR #719 + flow 334 merged) before Phase B.

## Risks

- `authoring-lint.ts`'s `STACK_EXTENSIONS` doesn't exist on this branch yet
  (ships with flow 334) — deferred to the Phase B rebase, not blocking
  Phase A authoring.
- No live gate run in Phase A means stability/agent generation is deferred;
  packs ship `stability: experimental` with no generated agent pair until
  Phase B's honest gate decides otherwise.
