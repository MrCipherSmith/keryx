# Flow 336 review round 4 — disposition/verification correction only

This round carries forward the same B1/M1-M6 findings from round r03 (same
`file`/`problem` identity) purely to attach dispositions and verification
evidence that cite the actual fixing commit SHA, per AC-C3's strict `fixed`
rule (`acted-on` requires the evidence to name a commit SHA, and the
verifier's `refuted` verdict must cite that same commit). No new content
issues; all seven were already fixed in review round 1's commits, and r03's
`--verifications` evidence simply never included the SHA the gate requires.

```keryx:findings
{
  "status": "consolidated",
  "reviewer": "review-orchestrator",
  "summary": "Round 4: re-record B1/M1-M6 dispositions and verifications with commit-SHA evidence so the review completion gate's AC-C3 `fixed` rule is satisfied. No new findings; all issues were fixed in review round 1.",
  "findings": [
    {
      "id": "B1",
      "reviewer": "review-orchestrator",
      "severity": "blocker",
      "problem": "CI was red: branch behind main, stale manifest.test.ts profile list, four scout.test.ts fixtures/pins invalidated by the larger catalog",
      "impact": "PR could not merge; CI never ran while the branch was also dirty against a moving main",
      "suggested_fix": "rebase/merge, re-pin fixtures honestly, re-measure the ratchet ceiling with per-trigger accounting",
      "evidence": "fixed by commit 07ff0bf7 (re-pin scout/manifest tests for the batch-4 catalog); gh pr checks 738 --watch reported all green before merge",
      "confidence": "high",
      "file": "src/gdskills/governance/scout.test.ts",
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
      "reviewer": "review-orchestrator",
      "severity": "major",
      "problem": "unstable composable parameter guidance predates Kotlin 2.0.20 strong-skipping-mode default",
      "impact": "guidance would tell a reader recomposition-skip is defeated when it usually is not under the current default",
      "suggested_fix": "correct to the instance-identity fallback mechanism",
      "evidence": "fixed by commit 1601c21b (correct kotlin-android content, M1-M3, M5); ctx7 Jetpack Compose developer docs (strong skipping default since Kotlin 2.0.20)",
      "confidence": "high",
      "file": "src/gdskills/bundled/stacks/kotlin-android/rules/patterns.mdc",
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
      "reviewer": "review-orchestrator",
      "severity": "major",
      "problem": "fictional Compose Compiler 1.5.x/Kotlin 2.0 compatibility pairing; deprecated lintOptions DSL",
      "impact": "guidance describes a compatibility problem that can no longer occur the way described",
      "suggested_fix": "correct to the Kotlin-2.0 plugin-versioned-with-Kotlin model; lint {} not lintOptions",
      "evidence": "fixed by commit 1601c21b (correct kotlin-android content, M1-M3, M5); ctx7 Compose Compiler docs (developer.android.com/develop/ui/compose/compiler)",
      "confidence": "high",
      "file": "src/gdskills/bundled/stacks/kotlin-android/skills/kotlin-android-build-fix/SKILL.md",
      "class_scope": {
        "sites": [
          "src/gdskills/bundled/stacks/kotlin-android/skills/kotlin-android-build-fix/SKILL.md"
        ],
        "enumeration_method": "grep for lintOptions/Compose-Compiler-version-pairing wording across the pack; only one skill referenced it"
      }
    },
    {
      "id": "M3",
      "reviewer": "review-orchestrator",
      "severity": "major",
      "problem": "EncryptedSharedPreferences recommended without the known-reliability-issue caveat",
      "impact": "guidance points at a library Google no longer recommends for new code",
      "suggested_fix": "prefer Android Keystore directly; state the reason",
      "evidence": "fixed by commit 1601c21b (correct kotlin-android content, M1-M3, M5); androidx security-crypto release notes",
      "confidence": "medium",
      "file": "src/gdskills/bundled/stacks/kotlin-android/rules/security.mdc",
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
      "reviewer": "review-orchestrator",
      "severity": "major",
      "problem": "MainActor isolation guidance didn't reflect View's default isolation since the iOS 18 SDK",
      "impact": "would require redundant @MainActor annotation on plain View-owned @State, and the mainactor-async-fetch eval scenario's subtle_wrong was arguably correct under the real rule",
      "suggested_fix": "state the real distinction: implicit for View-owned state, explicit for a separate model type",
      "evidence": "fixed by commit 7b746778 (correct swift-ios content, M4-M5); swift-migration-guide (partial)",
      "confidence": "medium",
      "file": "src/gdskills/bundled/stacks/swift-ios/rules/patterns.mdc",
      "class_scope": {
        "sites": [
          "src/gdskills/bundled/stacks/swift-ios/skills/swiftui-implementation/evals.json"
        ],
        "enumeration_method": "traced the MainActor claim from patterns.mdc into the one eval scenario that depended on it"
      }
    },
    {
      "id": "M5",
      "reviewer": "review-orchestrator",
      "severity": "major",
      "problem": "detectionMarkers for 3 batch-4 packs could false-fire or fail open (unknown marker keys, generic language tags)",
      "impact": "a Kotlin-DSL Spring project, a non-iOS Swift package, or a non-Flutter Dart package could all incorrectly install one of these packs",
      "suggested_fix": "narrow to the one real, exclusive detect.ts tag per pack; match pack.json to the manifest",
      "evidence": "fixed by commits 0ef781af (narrow batch-4 install-manifest detectionMarkers), 1601c21b (kotlin-android pack.json), 7b746778 (swift-ios), 8c85090f (flutter-dart); src/stack/detect.ts source read",
      "confidence": "high",
      "file": "src/gdskills/bundled/install-manifest.json",
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
      "reviewer": "review-orchestrator",
      "severity": "major",
      "problem": "--dart-define/.env claimed to keep a secret server-side",
      "impact": "guidance would tell a reader a build-time-injected value is safe on the device when it is compiled into the binary",
      "suggested_fix": "correct: both are compiled into the binary and equally recoverable; only source-control exposure differs",
      "evidence": "fixed by commits 8c85090f (flutter-dart content, M3/M5-M6) and bafe2852 (kotlin-android build-time-secret wording); general knowledge of Flutter build-time constant compilation",
      "confidence": "high",
      "file": "src/gdskills/bundled/stacks/flutter-dart/rules/security.mdc",
      "class_scope": {
        "sites": [
          "src/gdskills/bundled/stacks/kotlin-android/rules/security.mdc"
        ],
        "enumeration_method": "the narrow verification pass found the same error class uncorrected in kotlin-android's local.properties/CI-secret guidance"
      }
    }
  ],
  "stats": { "blocker": 1, "major": 6, "minor": 0, "info": 0 }
}
```
