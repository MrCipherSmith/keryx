# Implementation Plan

Status: formalized

## Approach

Four independent stack packs, one sonnet worker per pack, each worker owning
only its own `src/gdskills/bundled/stacks/<id>/` directory (per
stack-pack-lessons.md: "Parallel workers get disjoint pack directories; only
the runner edits shared files"). The runner (this flow) owns every shared
file: `install-manifest.json`, `STACK_EXTENSIONS` in `authoring-lint.ts`,
shared tests, and the W1/W2 docs. Template packs: `python`/`go` (stable, on
`main`, standalone "full pack" shape — the closest precedent for
`csharp-dotnet`) and `angular`/`vue`/`nestjs`/`mobx` (batch 2, on
`origin/flow/318-w4b2` / PR #719 — the closest precedent for a
framework-family pack's `pack.json`/`agentProfile` shape, read via `git show
origin/flow/318-w4b2:<path>`).

Rejected alternative: one worker for all four packs sequentially — rejected
for wall-clock cost; four independent language/framework surfaces have no
cross-pack coupling that would make sequential authoring safer.

Rejected alternative: treating `swift-ios`/`kotlin-android`/`flutter-dart`'s
"extends `lang:X`" table note as a real install-manifest dependency —
rejected because no `lang:swift`/`lang:kotlin`/`lang:dart` component exists
anywhere in the repo to depend on, and the table itself calls each a "full
pack" (ships everything). Documented in description.md.

## Steps

1. **T1 (context)**: runner reads W1/W2 specs, the rubric-scenario guide, and
   the python/go/angular/vue/nestjs/mobx templates (done inline by the
   runner before task dispatch — recorded here rather than delegated, since
   every worker needs the same digested pointers).
2. **T2 (implement)**: dispatch 4 parallel sonnet workers, one per stack
   (`csharp-dotnet`, `swift-ios`, `kotlin-android`, `flutter-dart`). Each
   authors `pack.json`, 4 rule files, `implement`/`test`/`review`/`build-fix`
   skills (`migrate` only if genuinely distinct — expect none of these four
   to need it, parallel to python/go), each skill's `evals.json` with
   judge-format behavior scenarios (rubric + pass/fail criteria + full
   4-way calibration + anti_patterns where a clean token exists), and
   `agent-refs.json` at `{"agents": [], "note": "..."}`. Workers verify
   version-specific claims via ctx7 before writing them (current
   SwiftUI/Swift concurrency for swift-ios, Jetpack Compose for
   kotlin-android, Flutter/Dart null-safety state for flutter-dart, current
   .NET version for csharp-dotnet).
3. **Runner-only, interleaved with T2's boundary commits**: wire each new
   pack into `install-manifest.json` (per-pack `<id>-rules`/`<id>-skills`
   modules, a `lang:<id>`/`framework:<id>` component with no dependency on a
   non-existent base, a per-stack profile, and additions to `full`), add
   `STACK_EXTENSIONS` entries in `authoring-lint.ts` for `.cs`/`.swift`/
   `.kt,.kts`/`.dart`.
4. **T3 (test)**: run the offline integrity/lint checks (guard tests under
   `src/gdskills/stack-pack-eval-integrity.test.ts`,
   `src/gdskills/stack-packs.test.ts`,
   `src/gdskills/governance/authoring-lint*.test.ts`, plus any
   install-manifest schema test) scoped to the touched files/packs. No
   model-backed gate in Phase A.
5. **T4 (review)**: runner self-review — confirm every rule's `paths:` glob
   matches only that stack's extensions (W1-AC8 shape), every pack shipped
   with `stability: experimental` and an empty `agents: []`, no shared file
   touched by a worker, no version bump/CHANGELOG edit — then push the branch
   and return `STATUS: READY_FOR_GATE`. Phase B tasks (calibration, honest
   gate, doc/AC updates, PR, adversarial review, merge) are added to this
   flow once the orchestrator gives the go-ahead, per the dispatch's own
   Phase B procedure.

## Risks

- Extending `STACK_EXTENSIONS`/`install-manifest.json` at the same time as
  worker commits land risks a merge race inside this one worktree — mitigated
  by doing the shared-file edits as the runner's own commits, interleaved
  between worker task-boundary commits (never concurrently), per
  git-concurrency.mdc.
- PR #719 and flow 334 change the same shared infra this flow's Phase B will
  touch (`extends` becomes an array, `extendsList`, trigger scoring) — Phase
  A deliberately does not touch `extends` shape or trigger-scoring code, so
  the rebase surface is limited to `install-manifest.json`, docs, and maybe
  `authoring-lint.ts`.
- Mobile/`.NET` ecosystem claims (Swift concurrency, Compose, Dart
  null-safety, .NET version) are more likely to be stale in training data
  than the batch 1/2 web stacks — mitigated by the ctx7 verification
  requirement in T2.
