---
name: flutter-build-fix
description: "Use when flutter analyze/flutter build fails, or pubspec.yaml/pubspec.lock are out of sync -- resolves dependency version conflicts, analyzer/lint failures, null-safety compile errors, and a failing flutter test, with the smallest root-cause fix."
triggers:
  - "flutter analyze is failing"
  - "flutter build is failing with a dependency error"
  - "fix this pubspec.yaml version conflict"
  - "resolve this Dart null-safety compile error"
  - "this Flutter lint is failing in CI"
  - "flutter test is failing after a pub upgrade"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Flutter/Dart build fix

Resolve a `flutter analyze`/`flutter build` failure, a `pubspec.yaml`/
`pubspec.lock` mismatch, a null-safety compile error, an analyzer/lint
failure, or a failing `flutter test` — with the smallest change that fixes
the actual root cause. `rules/coding-style.mdc` and `rules/security.mdc`
govern what a "correct" fix looks like; this skill never reaches for a
suppression instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
flutter analyze
dart format --set-exit-if-changed .
```

Read the exact error text and classify it:

- **Compile error** (undefined identifier, type mismatch, missing
  override).
- **Null-safety error** (a nullable value used where non-null is
  required, a missing `late`/`required`, an unhandled `null` case).
- **Dependency/version conflict** (`pubspec.yaml`/`pubspec.lock`
  mismatch, `flutter pub get` reporting a version solving failure).
- **Analyzer/lint finding** (`flutter analyze`'s own rules, or a rule from
  the project's `analysis_options.yaml`).
- **Failing test** (`flutter test` reports a failed `expect`/`find`
  assertion, or a widget test exception).

### Step 2: Fix by category

**Dependency/version conflict:** run `flutter pub get` (or `flutter pub
upgrade` when a newer compatible version is needed) and read the actual
version-solving error — it names which packages conflict and why. Check
`flutter pub deps` to see the dependency graph before pinning a version by
hand. Only add a `dependency_overrides` entry when it is a real,
intentional override (a known-good pre-release, a local path dependency
during development) — never to silently paper over a conflict without
understanding it, and say so in the report either way.

**Null-safety compile error:** fix the actual nullability gap — add a
null check, use `?.`/`??`, make a constructor parameter `required` or give
it a default, or correct a type that should not have been nullable in the
first place. Never add `!` purely to make the compiler stop complaining
without confirming the value is actually non-null at that point.

**Analyzer/lint finding:** fix the underlying issue the finding names
(the real missing override, the actual unused import, the genuine dead
code). Never add `// ignore: <rule>` or a blanket `// ignore_for_file:`
comment whose only purpose is to make the analyzer stop complaining
without addressing what it found.

**Failing test:** read the assertion failure and fix the actual cause —
either the implementation has a real bug the test correctly caught (fix
the implementation, say so), or the test/fixture is stale (fix the test).
Never delete or weaken a `find`/`expect` assertion just to reach green.

### Step 3: Verify

```bash
flutter analyze
dart format --set-exit-if-changed .
flutter test
```

Re-run `flutter build <platform>` if the original failure was a build (not
just an analyze/test) failure. All must exit 0 before reporting done.

### Step 4: Report

```
Fixed: pubspec.yaml/pubspec.lock version conflict (ran `flutter pub get`
  after loosening a pinned transitive constraint)
  - Root cause: pubspec.lock predated a direct dependency bump in
    pubspec.yaml
  - flutter analyze / dart format / flutter test all pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER add `// ignore:` or `// ignore_for_file:` to silence an analyzer
  finding instead of fixing what it found.
- NEVER add the bang operator (`!`) to a nullable value just to make a
  compile error disappear without confirming non-nullability.
- NEVER add a `dependency_overrides` entry to route around a real version
  conflict without confirming it is an intentional, documented override.
- NEVER delete or weaken a failing test's assertion to reach a green
  build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `// ignore: prefer_const_constructors` here so analyze passes" | Silences the finding without fixing the actual missed `const`, which is exactly the performance signal the lint exists to catch |
| "I'll just add `!` here so the compiler stops complaining about this nullable value" | Papers over a real null-safety gap the compiler correctly found; add a null check or `?.`/`??` instead of asserting past it |
| "This dependency conflict is annoying, I'll add a dependency_override to force the version I want" | Routes around a real incompatibility the version solver found without understanding why it conflicts; check `flutter pub deps` and resolve the actual conflict first |
| "This widget test is flaky, I'll just remove the assertion that's failing" | Hides a real bug or a genuinely broken test instead of fixing either one; read the failure and fix the actual cause |

## Verification

Do not report the fix done until all of the following hold:

- `flutter analyze`, `dart format --set-exit-if-changed .`, and `flutter
  test` all exit 0.
- `flutter build <platform>` exits 0 if the original failure was a build
  failure.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
