# Implementation Plan

Status: approved for freeze

## Approach

Fix each verified defect (context.md, D1-D12) at its source — `src/gdskills/bundled/**`,
`src/gdskills/*.ts`, `src/lib/templates.ts` — mirror it into `.metaproject/`, apply it to
every runtime build of a touched skill, and where a checker let the defect through, make
the checker catch it (xref against installed layout, compatible_harnesses/category checks,
destructive-git patterns, heading-only entrypoint body, retired-rule prune).

Decisions:

- Job context path: `<job>/ai/context.md` (24 files and the producer already use it); only
  job-orchestrator changes.
- Documentation layout: `requirements-package-standard` is the one layout (docpack and the
  real `docs/requirements/*` follow it); dated and ru/en/ai mandates are retired.
- Stack rules are labelled (`stack_requires` metadata) and documented as opt-in, not deleted
  and not install-gated in this flow.
- Project-skill footer stops asserting a status; it points at `verification.md`.
- Retired rules are pruned from an installation only when the installed copy is unmodified.

## Waves (workers never commit; the orchestrator commits each task's declared paths)

| Wave | Tasks (parallel within a wave, disjoint files) |
|---|---|
| W1 | T5 review rules+orchestrator, T7 verification commands, T12 rendered descriptions, T13 entrypoint body, T14 rule conflicts, T16 stack labels |
| W2 | T6 retired-rule prune, T8 job context path, T9 dead references, T17 verifier honesty |
| W3 | T10 xref on installed layout (then) T11 metadata checks; T15 git-concurrency rule |
| W4 | T3 full verification, T4 review |

## Risks

- Shared-file collisions between parallel workers: waves are cut on file ownership; each
  worker reports its exact file list and nothing else is staged.
- Tests pinning current wording (context.md list) break by design; each worker updates the
  pin in the same task and says why.
- The installed `keryx` binary is stale; every command runs from source.
