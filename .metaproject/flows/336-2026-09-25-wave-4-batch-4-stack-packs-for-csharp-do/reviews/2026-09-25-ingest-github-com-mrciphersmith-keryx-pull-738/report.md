# Flow 336 (W4 batch 4) — Consolidated adversarial review, PR #738

One opus adversarial review round against the stack-pack lessons checklist
(`stack-pack-lessons.md`), followed by a fix pass and a narrow opus
verification of that pass, plus two additional shared-file merge conflicts
(batch 5 #735, batch 6 via an earlier merge) resolved additively with fresh
ratchet re-measurements after the review closed. Round 1 found 1 blocker
(CI red), 6 majors, and several minors. All fixed; the narrow verification
pass confirmed every fix against its claim (VERIFIED, 9/9 items). CI green,
PR merged as squash commit f6eb6094.

## Blocker

### [B1] CI was red on this PR
- **Severity**: blocker
- Branch was behind `origin/main`; `manifest.test.ts`'s profile list was
  stale; `scout.test.ts` had four fixtures/pins the larger catalog
  invalidated (the acme-widget scoutImports fixture, the `quality/pr` vs
  `pr-issue-documenter` top-5-cutoff assertion, `react/react-code-review`'s
  stale honest-loss pin, and the trigger-fail ratchet ceiling).
- **Fix**: rebased, then (after the coordinator's guidance) switched to
  merge commits for two more origin/main syncs as concurrent batches
  landed; all four `scout.test.ts` items re-pinned honestly with
  per-trigger accounting in the test's own comments; ratchet ceiling
  re-measured at each merge (181→185→212 as batches 4/5/6 combined).

## Major

### [M1] Kotlin Compose strong-skipping-mode guidance was stale
- **Severity**: major
- `patterns.mdc`/`compose-implementation`/`kotlin-android-code-review`
  claimed an unstable composable parameter "defeats the compiler's skip
  check" — stale since strong skipping became the Kotlin 2.0.20 default.
- **Fix**: corrected to the real mechanism (instance-identity fallback),
  ctx7-verified against Compose developer docs.

### [M2] Compose Compiler/Kotlin version-pairing guidance was fictional
- **Severity**: major
- `kotlin-android-build-fix` described a "Compose Compiler 1.5.x vs Kotlin
  2.0" compatibility pairing that predates the Kotlin-2.0 plugin migration;
  also used the deprecated `lintOptions` DSL block.
- **Fix**: corrected to the real `org.jetbrains.kotlin.plugin.compose`
  Gradle-plugin-versioned-with-Kotlin model; `lintOptions` → `lint {}`.

### [M3] EncryptedSharedPreferences recommended without caveat
- **Severity**: major
- `security.mdc` (kotlin-android, flutter-dart) recommended
  EncryptedSharedPreferences unconditionally; it has known reliability
  issues and is no longer recommended by Google for new code.
- **Fix**: both packs now prefer the Android Keystore directly, with the
  reason stated.

### [M4] Swift MainActor-isolation guidance didn't match the current SDK
- **Severity**: major
- `patterns.mdc` and the `mainactor-async-fetch` eval scenario required
  explicit `@MainActor` even for state kept directly on a `View` — but
  `View` conformance is `@MainActor`-isolated by default since the iOS 18
  SDK.
- **Fix**: corrected the rule and the scenario's pass criteria/known_right/
  subtle_wrong to state the real distinction (implicit for View-owned
  state, explicit for a separate model type); calibration re-recorded.

### [M5] detectionMarkers could false-fire or fail open
- **Severity**: major
- `swift-ios`/`kotlin-android`/`flutter-dart` `detectionMarkers` included
  extra markers, two of which (`gradle`, `xcode`) were never real
  `stack.json` tags at all — an unknown marker key fails
  `resolveComponentInclusion` OPEN (installed unconditionally), and
  `kotlin`/`swift`/`dart` alone also fire for unrelated projects (a
  Kotlin-DSL Spring project, a non-iOS Swift package, a non-Flutter Dart
  package).
- **Fix**: narrowed each to the one real, exclusive `detect.ts` tag
  (`["android"]`, `["ios"]`, `["flutter"]`); matched in
  `install-manifest.json`; added 3 regression tests.

### [M6] Flutter `--dart-define`/`.env` claimed to keep a secret server-side
- **Severity**: major
- `security.mdc` claimed a build-time `--dart-define`/`.env` value stays
  server-side — both are compiled into the binary exactly like a literal.
- **Fix**: corrected; same class of error also found and fixed in
  kotlin-android's equivalent guidance during the narrow verification pass.

## Minor (bundled — full list in the flow journal's review-round section)

- Fail-criteria wording gaps that missed a "redundant delay bolted onto a
  real signal" case in 2 scenarios (C#, Flutter); a URLProtocol-based
  `subtle_wrong` that was arguably a legitimate technique, reworded to a
  genuinely wrong answer; copied-Go-pack leftover terminology in 3 packs
  (`goroutine-equivalent`, `wantErr-style`, a `select`/`if` "gate");
  a prose (non-literal) `anti_patterns` token removed; C# nullable-
  reference-types history precision; Kotlin's false multi-catch claim;
  GlobalScope/pump-settle rubric rationale tightening; a stale ratchet
  timeout comment.
- **Fix**: all addressed in the review-round-1 fix commits; calibration
  re-recorded for every skill whose `evals.json` changed.

## Info

- The I11-rewording (11 trigger prompts diversified in `csharp-dotnet`/
  `flutter-dart`, before the honest gate ran) plausibly contributed to some
  of the gate's own trigger-positive misses by dropping stack-naming words
  in the process of avoiding a near-verbatim restatement. Recorded in the
  W1 doc and flow journal, not re-touched (would be tuning eval wording to
  the gate result).
- ctx7 verification evidence for every version-specific claim (Phase A and
  review-round-1 fixes alike) recorded in the flow journal, per a review
  round 1 minor asking for the evidence behind the doc's ctx7 claim.

```json keryx:findings
[
  {
    "status": "DONE_WITH_CONCERNS",
    "reviewer": "review-orchestrator",
    "summary": "1 blocker, 6 majors, several minors, 2 info; all blocker/major findings fixed and verified (narrow opus pass: VERIFIED, 9/9) before merge",
    "findings": [
      {
        "id": "B1",
        "severity": "blocker",
        "file": "src/gdskills/governance/scout.test.ts",
        "problem": "CI was red: branch behind main, stale manifest.test.ts profile list, four scout.test.ts fixtures/pins invalidated by the larger catalog",
        "impact": "PR could not merge; CI never ran while the branch was also dirty against a moving main",
        "suggested_fix": "rebase/merge, re-pin fixtures honestly, re-measure the ratchet ceiling with per-trigger accounting",
        "evidence": "bun test failures; gh pr checks showing CI red",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/manifest/manifest.test.ts",
            "src/gdskills/bundled/install-manifest.json"
          ],
          "enumeration_method": "ran the full targeted suite (manifest.test.ts, scout.test.ts, stack-pack-eval-integrity.test.ts) and fixed every failure"
        }
      },
      {
        "id": "M1",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/kotlin-android/rules/patterns.mdc",
        "problem": "unstable composable parameter guidance predates Kotlin 2.0.20 strong-skipping-mode default",
        "impact": "guidance would tell a reader recomposition-skip is defeated when it usually is not under the current default",
        "suggested_fix": "correct to the instance-identity fallback mechanism",
        "evidence": "ctx7 Jetpack Compose developer docs (strong skipping default since Kotlin 2.0.20)",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/kotlin-android/skills/compose-implementation/SKILL.md",
            "src/gdskills/bundled/stacks/kotlin-android/skills/kotlin-android-code-review/SKILL.md"
          ],
          "enumeration_method": "grep for unstable-parameter/skip-check wording across the pack"
        }
      },
      {
        "id": "M2",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/kotlin-android/skills/kotlin-android-build-fix/SKILL.md",
        "problem": "fictional Compose Compiler 1.5.x/Kotlin 2.0 compatibility pairing; deprecated lintOptions DSL",
        "impact": "guidance describes a compatibility problem that can no longer occur the way described",
        "suggested_fix": "correct to the Kotlin-2.0 plugin-versioned-with-Kotlin model; lint {} not lintOptions",
        "evidence": "ctx7 Compose Compiler docs (developer.android.com/develop/ui/compose/compiler)",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/kotlin-android/skills/kotlin-android-build-fix/SKILL.md"
          ],
          "enumeration_method": "grep for lintOptions/Compose-Compiler-version-pairing wording across the pack; only one skill referenced it"
        }
      },
      {
        "id": "M3",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/kotlin-android/rules/security.mdc",
        "problem": "EncryptedSharedPreferences recommended without the known-reliability-issue caveat",
        "impact": "guidance points at a library Google no longer recommends for new code",
        "suggested_fix": "prefer Android Keystore directly; state the reason",
        "evidence": "androidx security-crypto release notes (bug fixes referenced); general knowledge of the library's known issues",
        "confidence": "medium",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/flutter-dart/rules/security.mdc",
            "src/gdskills/bundled/stacks/kotlin-android/skills/kotlin-android-code-review/SKILL.md"
          ],
          "enumeration_method": "grep for EncryptedSharedPreferences across both packs that reference the Android backing store"
        }
      },
      {
        "id": "M4",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/swift-ios/rules/patterns.mdc",
        "problem": "MainActor isolation guidance didn't reflect View's default isolation since the iOS 18 SDK",
        "impact": "would require redundant @MainActor annotation on plain View-owned @State, and the mainactor-async-fetch eval scenario's subtle_wrong was arguably correct under the real rule",
        "suggested_fix": "state the real distinction: implicit for View-owned state, explicit for a separate model type",
        "evidence": "swift-migration-guide (partial), general knowledge of the iOS 18 SDK's View isolation default",
        "confidence": "medium",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/swift-ios/skills/swiftui-implementation/evals.json"
          ],
          "enumeration_method": "traced the MainActor claim from patterns.mdc into the one eval scenario that depended on it"
        }
      },
      {
        "id": "M5",
        "severity": "major",
        "file": "src/gdskills/bundled/install-manifest.json",
        "problem": "detectionMarkers for 3 batch-4 packs could false-fire or fail open (unknown marker keys, generic language tags)",
        "impact": "a Kotlin-DSL Spring project, a non-iOS Swift package, or a non-Flutter Dart package could all incorrectly install one of these packs",
        "suggested_fix": "narrow to the one real, exclusive detect.ts tag per pack; match pack.json to the manifest",
        "evidence": "src/stack/detect.ts source read; src/gdskills/manifest/plan.ts's resolveComponentInclusion fail-open behavior on an unknown marker key",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/swift-ios/pack.json",
            "src/gdskills/bundled/stacks/kotlin-android/pack.json",
            "src/gdskills/bundled/stacks/flutter-dart/pack.json"
          ],
          "enumeration_method": "read detect.ts's full STACK_DETECT_TAGS list and cross-checked every batch-4 pack's detectionMarkers against it"
        }
      },
      {
        "id": "M6",
        "severity": "major",
        "file": "src/gdskills/bundled/stacks/flutter-dart/rules/security.mdc",
        "problem": "--dart-define/.env claimed to keep a secret server-side",
        "impact": "guidance would tell a reader a build-time-injected value is safe on the device when it is compiled into the binary",
        "suggested_fix": "correct: both are compiled into the binary and equally recoverable; only source-control exposure differs",
        "evidence": "general knowledge of Flutter build-time constant compilation",
        "confidence": "high",
        "class_scope": {
          "sites": [
            "src/gdskills/bundled/stacks/kotlin-android/rules/security.mdc"
          ],
          "enumeration_method": "the narrow verification pass found the same error class uncorrected in kotlin-android's local.properties/CI-secret guidance"
        }
      },
      {
        "id": "MIN-1",
        "severity": "minor",
        "problem": "multiple minor content/wording/calibration issues bundled (see report body)",
        "impact": "various small correctness/clarity gaps",
        "suggested_fix": "see report body for the full itemized list",
        "evidence": "manual review of pack content and eval scenario calibration",
        "confidence": "medium"
      },
      {
        "id": "INFO-1",
        "severity": "info",
        "problem": "I11-rewording (before the gate) plausibly contributed to some of the gate's own trigger-positive misses",
        "impact": "documented interaction, not a defect requiring a fix; re-wording after the gate would be tuning to the result, which the standing rule forbids",
        "suggested_fix": "no action needed; recorded in W1 doc and flow journal",
        "evidence": "flow 336 journal's I11-rewording/trigger-failure interaction section",
        "confidence": "high"
      }
    ],
    "stats": { "blocker": 1, "major": 6, "minor": 1, "info": 1 }
  }
]
```
