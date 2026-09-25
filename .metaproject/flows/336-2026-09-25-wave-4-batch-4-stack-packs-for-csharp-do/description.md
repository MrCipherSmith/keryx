# Wave 4 batch 4: stack packs for csharp-dotnet, swift-ios, kotlin-android, flutter-dart

Status: formalized
Source: runner dispatch (flow-runner-template.md + stack-pack-lessons.md)

## Problem

The agent-platform-expansion stack catalog
(`docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md`)
targets a full set of stack packs under `src/gdskills/bundled/stacks/<id>/`.
Wave 4 authors these in batches: batch 1 (flow 314/316/317, on `main`) shipped
`ts-js-node`/`react`/`python`/`go`; batch 2 (flow 318, PR #719, **not yet
merged**) ships `angular`/`vue`/`nestjs`/`mobx`. This flow is batch 4: four
more packs, all marked "full pack" in the W1 target-stack table:

- `csharp-dotnet` (family: language)
- `swift-ios` (family: framework; table note: "extends `lang:swift`")
- `kotlin-android` (family: framework; table note: "extends `lang:kotlin`")
- `flutter-dart` (family: framework; table note: "extends `lang:dart`")

None of `lang:swift`/`lang:kotlin`/`lang:dart` exist anywhere in the catalog
as authored packs or install-manifest components — unlike `react`/`angular`,
which genuinely extend the already-authored `ts-js-node` pack. Since the
table marks these four as "full pack" (ships every rule/skill itself), this
flow treats them as standalone packs with no install-manifest
`extends`/`dependencies` chain onto a base that does not exist. Recorded here
as a runner decision, not silently assumed.

## Expected outcome

Four new stack packs under `src/gdskills/bundled/stacks/<id>/`, each with the
fixed shape from W1 (`pack.json`, `rules/{coding-style,patterns,security,testing}.mdc`
each with a correct `paths:` glob for that stack's file types and
`extends: common`, `skills/{implement,test,review,build-fix}/SKILL.md`
+ `evals.json` at minimum with judge-format behavior scenarios per the
flow-316/317 lessons and `docs/docs/guides/write-a-rubric-scenario.md`,
`migrate` skill only where genuinely distinct, `agent-refs.json`), wired into
`src/gdskills/bundled/install-manifest.json` (per-pack modules, components, a
per-stack profile, and the `full` profile) and `STACK_EXTENSIONS` in
`src/gdskills/governance/authoring-lint.ts` (`.cs`; `.swift`; `.kt`/`.kts`;
`.dart`). All version-specific technical claims (current SwiftUI/Swift
concurrency, Jetpack Compose, Flutter/Dart null-safety, .NET version) verified
against ctx7 docs, not training-data recall.

**Phase A (this dispatch)**: author and offline-lint the four packs at
`stability: experimental`, `agent-refs.json` → `{"agents": [], "note": "no
honest gate run yet (Phase A of flow 336)"}`. Push the branch and return
`STATUS: READY_FOR_GATE`.

**Phase B (after the orchestrator's go-ahead)**: rebase onto `main` once PR
#719 (batch 2) and flow 334 (negation-aware trigger scorer) are merged,
record calibration (`skills judge-check --record`), run the honest 10-trial
DeepSeek gate (`skills eval --scope bundled --runner deepseek:deepseek-chat
--judge deepseek:deepseek-chat --strictness high --trials 10`), set final
`stability`/generated agent pairs strictly from those results, update
W1/W2 docs and this flow's ACs with the real outcome, open the PR into
`main`, run an adversarial Opus review, get CI green, and merge per the
standing rule (threshold minor, ≤3 attempts, then 0 blocker/major merges with
minors deferred "decided-by: MrCipherSmith (owner, in chat), standing rule").

## Out of scope

- Running `keryx skills judge-check`/`skills eval` against a live model in
  Phase A.
- Editing anything under PR #719's or flow 334's own files beyond what a
  rebase conflict forces.
- Any other stack in the W1 catalog table.
- Version bumps or CHANGELOG release sections.
- Bumping `PACK_MIN_TRIALS`/`PACK_BEHAVIOR_PASS_FLOOR`/judge/runner prompt
  versions — those are shared infra, not this flow's to touch.
