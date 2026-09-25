# Flow Journal

- 2026-09-25T15:14:46.872Z - flow created
- 2026-09-25T15:20:56.639Z - task-done: T1: Collect remaining context
- 2026-09-25T15:21:00.881Z - frozen: 8 criteria; checksum recorded
- 2026-09-25T15:21:04.524Z - started
- 2026-09-25T15:21:24.988Z - task-attempt: T2: started (attempt 1) — dispatching 4 parallel sonnet workers, one per stack pack
- 2026-09-25T15:38:19.945Z - task-done: T2: Implement per plan
- 2026-09-25T15:38:24.986Z - task-attempt: T3: started (attempt 1) — running offline integrity/lint guard tests scoped to the 4 new packs and shared wiring
- 2026-09-25T15:38:25.275Z - task-done: T3: Add/adjust tests and make them pass
- Phase A summary. 4 parallel sonnet workers authored
  `csharp-dotnet`/`swift-ios`/`kotlin-android`/`flutter-dart` stack packs,
  each confined to its own `src/gdskills/bundled/stacks/<id>/` directory. The
  runner ran `keryx skills scout --record` for all 16 skills (fixing stale
  duplicate scout entries and missing `--justification` on fork decisions
  before they passed `stack-packs.test.ts`'s F21 policy check), wired all
  four packs into `install-manifest.json` (modules/components/per-stack
  profiles/`full`, standalone — no `lang:swift`/`lang:kotlin`/`lang:dart`
  base exists, see description.md), and added their extensions to
  `STACK_EXTENSIONS` in `authoring-lint.ts`. Shortened 3 profile
  descriptions to fit the schema's 280-char cap (caught by
  `stack-packs.test.ts`'s manifest-parse step) — content fix, not scope.
- Offline checks green: `stack-packs.test.ts` (124/124),
  `authoring-lint.test.ts` + `authoring-lint-guard.test.ts` (31/31),
  `bundled-eval.test.ts`/`enforcement-claims.test.ts`/
  `agent-catalogue-xref.test.ts`/`catalog-frontmatter.test.ts`/
  `skill-name-matches-directory.test.ts`/`catalog-single-source.test.ts`/
  `bundled-no-persona.test.ts`/`build-parity.test.ts` (261/261).
  `stack-pack-eval-integrity.test.ts` has 256 failures, ALL of the expected
  `AG ... no judge recording for <pack>/<skill> yet` shape (Phase B work) —
  confirmed zero I1-I9 content-integrity failures by filtering the output.
- Every pack shipped `stability: "experimental"`, `agent-refs.json`
  `{"agents": [], "note": "..."}` — no gate result claimed.
- Decision recorded: `swift-ios`/`kotlin-android`/`flutter-dart` ship
  standalone (no `extends` in `pack.json`, no install-manifest dependency
  chain) because no `lang:swift`/`lang:kotlin`/`lang:dart` component exists
  anywhere in the catalog to extend, despite the W1 table's "extends lang:X"
  note — the same table calls each one a "full pack".
- Diff vs the branch point (335f730c) confirmed clean: only the flow
  package, the 4 pack directories, and the 2 shared-file commits — no
  version bump, no CHANGELOG edit, no file outside stated scope.
- T4 (self-review) done inline by the runner above; pushing branch and
  returning `STATUS: READY_FOR_GATE` per the dispatch's pause point (waiting
  on PR #719 and flow 334 to merge before Phase B rebase + honest gate).
- 2026-09-25T15:39:09.538Z - task-attempt: T4: started (attempt 1) — runner self-review: diff scope, stability/agents, offline checks all green
- 2026-09-25T15:39:09.813Z - task-done: T4: Self-review and prepare draft PR

## Phase B

- Rebased `flow/336-w4b4` onto `origin/main` (PR #719 batch-2 + flow 334
  negation-aware scorer, both merged: `b722dc52`, `5cc2c5b3`). Two real
  conflicts: `install-manifest.json` and `authoring-lint.ts`'s
  `STACK_EXTENSIONS` — both pure additive collisions (batch 2 and batch 4
  each appended new entries after the same `go`/`lang:go` anchor); resolved
  by rebuilding `install-manifest.json` from origin/main's clean copy and
  re-inserting the 4 batch-4 profiles/modules/components, and merging both
  `STACK_EXTENSIONS` blocks. A third conflict on
  `.metaproject/data/wiki/freshness-queue.jsonl` (an auto-regenerated data
  file, not authored content) resolved by keeping the freshly-rebuilt
  version. `install-manifest.json` schema itself is unchanged by batch 2/
  flow 334 — no `extends`-array or `extendsList` field exists in that file;
  those live in pack.json/trigger-scoring code, which batch 4 doesn't touch.
- I11 (negation-aware trigger-overlap check) added `csharp-dotnet`,
  `swift-ios`, `kotlin-android`, `flutter-dart` to
  `I11_ENFORCED_PACKS` (`src/gdskills/stack-pack-eval-integrity.test.ts`) —
  authored after I11 existed, so enforced from the start like batch 2,
  unlike batch 1's deferred exemption. Found and fixed 11 positive trigger
  prompts across `csharp-dotnet/dotnet-testing` (2), `flutter-dart/
  flutter-build-fix` (4), `flutter-dart/flutter-code-review` (2), and
  `flutter-dart/flutter-testing` (3) that restated their own skill's
  frontmatter `triggers:` closely enough to trip the 0.5 Jaccard threshold —
  reworded to realistic, substantially different phrasing describing the
  same scenario. `swift-ios` and `kotlin-android` needed no I11 fixes.
- Stable-pack protection: ran `checkStablePackGate(packDir, "stable")`
  directly against `go` and `python` after adding all four batch-4 packs to
  the bundled catalog — both still `{"status":"pass"}`. No collision; no fix
  needed; go/python evals were never touched.
- Calibration: `keryx skills judge-check <pack>/<skill> --judge
  deepseek:deepseek-chat --scope bundled --samples 3 --record` for all 16
  skills (4 packs × 4 skills). Every one of the 8 canned answers (empty,
  echo, vague, known-wrong, subtle-wrong, injection, stuffed, known-right)
  graded to its expected verdict on the FIRST attempt for every skill — no
  calibration answers or scenarios needed fixing.
- Honest gate: `keryx skills eval <pack>/<skill> --scope bundled --runner
  deepseek:deepseek-chat --judge deepseek:deepseek-chat --strictness high
  --trials 10 --json`, one CLI call per skill (16 total), HEAD unchanged
  start to end for every call. Full per-skill numbers (true positive /
  positives, false positive / negatives, behavior scenario pass rates):
  - `csharp-dotnet`: dotnet-implementation TP2/7 FP1/8 (behaviors 1.0, 1.0);
    dotnet-testing TP4/7 FP0/8 (1.0, 1.0); dotnet-code-review TP3/7 FP0/8
    (1.0, 1.0); dotnet-build-fix TP1/7 FP0/8 (0.9, 0.8).
  - `swift-ios`: swiftui-implementation TP1/7 FP0/7 (1.0, 1.0); swift-testing
    TP3/7 FP0/7 (1.0, 1.0); swift-code-review TP2/6 FP2/7 (1.0, 1.0);
    swift-build-fix TP1/6 FP0/7 (1.0, 1.0).
  - `kotlin-android`: compose-implementation TP3/7 FP0/7 (1.0, 1.0);
    kotlin-android-testing TP3/7 FP0/7 (1.0, 1.0); kotlin-android-code-review
    TP4/7 FP0/7 (1.0, 1.0); kotlin-android-build-fix TP4/7 FP0/7 (1.0, 0.9).
  - `flutter-dart`: flutter-implementation TP6/7 FP2/7 (1.0, 1.0);
    flutter-testing TP3/7 FP2/7 (1.0, 1.0); flutter-code-review TP6/7 FP4/7
    (1.0, 1.0); flutter-build-fix TP3/7 FP2/7 (1.0, 1.0).
  - Every single behavior scenario across all 16 skills clears
    `PACK_BEHAVIOR_PASS_FLOOR` (0.8); the content itself is strong. Every
    failure is trigger accuracy. `checkStablePackGate(packDir, "stable")`
    against all four packs: all four `{"status":"fail", ...}`, each naming
    the specific skill/reason.
- **No SKILL.md/evals.json edits were made after seeing any of the above
  numbers, for any of the 16 skills.** Per the coordinator's rule (and the
  batch-6 lesson it cites): the only allowed post-gate edit is a
  description/triggers line stating a skill's real, general scope boundary
  — never a rewrite that restates a failing eval prompt's wording. Looking
  at the failure pattern honestly: every pack's own "Read-only, no edits" /
  scope language was ALREADY present before the gate ran (see each pack's
  `pack.json`/SKILL.md, authored in Phase A) and the router still missed —
  csharp-dotnet/dotnet-build-fix failed on prompts using genuinely
  .NET-specific vocabulary ("NuGet", "StyleCop", "CS error") that a
  description already lists; flutter-dart/flutter-code-review's worst false
  positive was a prompt that explicitly asked to "also fix the bugs you
  find" against a skill already described as "Read-only, no edits". No
  candidate edit I could construct addressed a genuine, previously-missing
  scope gap without either (a) restating the exact wording of a failing
  eval prompt, which is forbidden, or (b) repeating a scope statement the
  description already made, which does nothing. Concluded this is the
  genuine, catalog-scale routing weakness the coordinator's message
  anticipated (many stacks now share near-identical implement/test/review/
  build-fix category framing) — not a fixable authoring defect. Run 1 is
  therefore the official result for all 16 skills; nothing was reverted
  because nothing was changed.
- **Result: all four batch-4 packs stay `stability: "experimental"`,
  `agent-refs.json` → `agents: []`** with the real per-skill numbers and
  reasoning recorded in each pack's own `agent-refs.json` note. No generated
  `<id>-code-auditor`/`<id>-build-fixer` pair ships for any of the four.
  `governance/eval.json` per pack is the 4 raw `skills eval` outputs,
  verbatim, wrapped in `{schemaVersion, reports}`.
