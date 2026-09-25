---
name: kotlin-android-build-fix
description: "Use when a Gradle Android build, ktlintCheck, detekt, or lint task fails, or a Kotlin compile/type error blocks the build -- resolves Gradle/AGP/Kotlin version mismatches, Compose Compiler mismatches, unresolved dependencies, and lint/detekt findings with the smallest root-cause fix."
triggers:
  - "the Android build is failing"
  - "gradle sync is broken after this change"
  - "detekt is failing on this module"
  - "lint is flagging this Android change"
  - "this Kotlin file won't compile"
  - "resolve this dependency conflict in build.gradle"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Kotlin/Android build fix

Resolve a Gradle/Android build failure: a Kotlin compile error, a
Gradle/AGP/Kotlin/Compose-Compiler version mismatch, an unresolved
dependency, or a `ktlint`/`detekt`/`lint` failure — with the smallest
change that fixes the actual root cause. `rules/coding-style.mdc` and
`rules/security.mdc` govern what a "correct" fix looks like; this skill
never reaches for a suppression instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
./gradlew assembleDebug
./gradlew lint
```

Run the project's configured static-analysis task if present
(`./gradlew ktlintCheck` or `./gradlew detekt`, checked via a
`.editorconfig`/`ktlint`/`detekt.yml` config file). Read the exact error
text and classify it:

- **Compile error** (unresolved reference, type mismatch, wrong argument
  count, an unhandled `when` branch on a sealed type).
- **Version/toolchain mismatch** (Kotlin/AGP/Gradle/Compose-Compiler
  versions incompatible with each other, or with the project's declared
  `compileSdk`/`minSdk`).
- **Dependency resolution failure** (a missing/conflicting artifact
  version in `build.gradle(.kts)`, a version-catalog entry that doesn't
  resolve).
- **Lint finding** (`./gradlew lint`'s own Android Lint checks).
- **ktlint/detekt finding** (a style or static-analysis rule violation).

### Step 2: Fix by category

**Version/toolchain mismatch:** since Kotlin 2.0, the Compose Compiler ships
via the `org.jetbrains.kotlin.plugin.compose` Gradle plugin versioned
IDENTICALLY to the Kotlin version itself (`version.ref = "kotlin"` in the
version catalog) — there is no separate compiler-to-Kotlin compatibility
matrix to consult on a current project; a mismatch here usually means the
plugin's declared version drifted from the Kotlin version, or (pre-2.0
project) an old `composeOptions { kotlinCompilerExtensionVersion }`
declaration left over from before the plugin migration. Align the plugin
version to match Kotlin exactly, or migrate off `kotlinCompilerExtensionVersion`
to the plugin. Only bump `compileSdk`/`minSdk` when the failure actually
requires the newer API, and say so in the report.

**Dependency resolution failure:** run `./gradlew :module:dependencies
--configuration <config>` to see the actual resolved tree before pinning
a version by hand; prefer aligning versions through the project's version
catalog (`libs.versions.toml`) over an ad hoc `resolutionStrategy` force,
unless the conflict is a genuine, documented incompatibility that needs
one.

**Lint finding:** fix the underlying issue the finding names (a real
resource/API-level issue, a missing content description, an exported
component with no permission). Never add a blanket `lint {
abortOnError = false }`/`disable` entry (the current Android Gradle Plugin
DSL block is `lint { }`; the older `lintOptions { }` block is deprecated)
or a file-level `@Suppress` whose only purpose is to make the check stop
complaining without addressing what it found; a narrowly-scoped, justified
suppression at the single call site (with a comment explaining why) is the
last resort, not the first move.

**ktlint/detekt finding:** fix the actual style/complexity issue the rule
names. Never disable the rule project-wide in `.editorconfig`/
`detekt.yml` to silence one occurrence without discussing it in the
report.

**Compile error (sealed `when` not exhaustive):** add the missing branch
handling the new/overlooked case — never an `else -> {}` branch that
silently swallows a case a sealed hierarchy was specifically designed to
force you to handle.

### Step 3: Verify

```bash
./gradlew assembleDebug
./gradlew testDebugUnitTest
./gradlew lint
```

Re-run the project's `ktlintCheck`/`detekt` task if it was part of the
original failure. All must exit 0 before reporting done.

### Step 4: Report

```
Fixed: Compose Compiler plugin version mismatch in gradle/libs.versions.toml
  - Root cause: org.jetbrains.kotlin.plugin.compose left pinned to the old
    Kotlin version after a Kotlin bump (the plugin must track Kotlin exactly
    since Kotlin 2.0, not a separate compatibility pairing)
  - Set the plugin's version.ref to the same catalog entry as kotlin
  - ./gradlew assembleDebug/testDebugUnitTest/lint all pass
```

State the root cause in one sentence, not just "build now passes."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER add a blanket `@Suppress`, `lint { abortOnError = false }`,
  or a project-wide `detekt`/`ktlint` rule disable to silence a finding
  instead of fixing what it found.
- NEVER bump `compileSdk`, `minSdk`, or a major Gradle/Kotlin/AGP version
  just to make an error disappear without understanding why it changed.
- NEVER replace a non-exhaustive sealed `when`'s missing branch with a
  catch-all `else` that discards the case it exists to force you to
  handle.
- NEVER delete or skip a failing test to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `@Suppress(\"..\")` at the top of the file so detekt stops complaining" | Silences every finding of that type in the whole file instead of fixing the one the build actually flagged; fix the underlying issue at the specific site instead |
| "I'll bump compileSdk to the latest to make this dependency resolve" | Changes the module's target API surface for every consumer to dodge one dependency conflict; check the actual required version first |
| "I'll add an `else -> {}` branch so this `when` compiles" | Defeats the reason the state was modeled as sealed in the first place — a genuinely new case now silently does nothing instead of failing to compile |
| "This lint check is annoying, I'll just disable it in the module's lint block" | Turns off the check for every future file in the module, not just this one finding; fix the finding or scope a suppression narrowly with a reason |

## Verification

Do not report the fix done until all of the following hold:

- `./gradlew assembleDebug`, `./gradlew testDebugUnitTest`, and
  `./gradlew lint` all exit 0.
- The project's `ktlintCheck`/`detekt` task (if configured) exits 0.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
