---
name: swift-build-fix
description: "Use when xcodebuild/swift build fails, or a Swift 6 strict-concurrency/Sendable error, SwiftLint failure, or failing test blocks the build -- resolves the root cause instead of force-unwrapping, adding @unchecked Sendable, or disabling a lint rule to silence the check."
triggers:
  - "xcodebuild is failing"
  - "swift build error"
  - "fix this Swift 6 concurrency error"
  - "SwiftLint is failing"
  - "resolve this Sendable conformance error"
  - "this Swift test is failing, fix the build"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Swift/iOS build fix

Resolve an `xcodebuild`/`swift build` failure, a Swift 6 strict-
concurrency or `Sendable` conformance error, a SwiftLint/swift-format
failure, or a failing test blocking the build — with the smallest change
that fixes the actual root cause. `rules/coding-style.mdc` and
`rules/patterns.mdc` govern what a "correct" fix looks like; this skill
never reaches for a suppression instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
xcodebuild build -scheme <Scheme> -destination 'platform=iOS Simulator,name=<Simulator>'
# or, for a Swift package:
swift build
```

Run the project's configured linter/formatter if present (`swiftlint`,
`swift-format lint`/`swiftformat --lint`). Read the exact error text and
classify it:

- **Compile error** (undefined symbol, type mismatch, wrong argument
  count/label).
- **Concurrency/Sendable** (`Sendable` conformance error, an actor-
  isolation error, a Swift 6 strict-concurrency diagnostic).
- **Optional-binding warning** (a `guard`/`if let` the compiler flags as
  always-succeeding or a value it infers as never-nil).
- **Dependency/toolchain** (Swift Package Manager resolution failure, a
  CocoaPods/Carthage mismatch, an Xcode/Swift toolchain version the
  project's minimum predates).
- **Lint/format finding** (SwiftLint rule, swift-format/swiftformat
  diagnostic).
- **Failing test** blocking a scheme that runs tests as part of build.

### Step 2: Fix by category

**Concurrency/Sendable:** read exactly what the compiler says is
crossing the boundary unsafely. If the type's mutable state genuinely
needs protecting, isolate it with an `actor` or `@MainActor`; if it is
genuinely immutable, conform it to `Sendable` properly (all stored
properties `Sendable`, or an explicit, justified conformance). Only use
`@unchecked Sendable` when you can state in the report exactly why the
type's access pattern is safe despite the compiler being unable to prove
it — never as a default move to clear the error.

**Optional-binding warning:** fix the actual type/control-flow issue the
compiler is pointing at (a value that genuinely cannot be nil should not
be declared `Optional`; a value that can be nil needs the `guard`/`if
let` the compiler is questioning). Never force-unwrap (`!`) to silence
the warning instead of addressing why the compiler flagged it.

**Dependency/toolchain:** for a Swift Package Manager resolution
failure, check `Package.resolved` against `Package.swift`'s declared
requirements before bumping a version by hand; for a toolchain mismatch,
confirm the project's actual minimum Swift/Xcode version before changing
`swift-tools-version` or the deployment target just to make an error
disappear.

**Lint/format finding:** fix the underlying issue the rule names (a real
force-unwrap, a genuinely too-long function, an unused variable). Never
add a blanket `// swiftlint:disable` covering more than the one flagged
line, and never disable a rule repository-wide in `.swiftlint.yml` to
clear one finding without discussing why the rule itself is wrong for
this codebase.

**Failing test:** read the failure and fix the actual regression it
caught; do not delete, skip (`.disabled()`/`XCTSkip` used to dodge
rather than genuinely skip an environment-specific case), or loosen the
test's assertion just to reach a green build.

### Step 3: Verify

```bash
xcodebuild build -scheme <Scheme> -destination 'platform=iOS Simulator,name=<Simulator>'
xcodebuild test -scheme <Scheme> -destination 'platform=iOS Simulator,name=<Simulator>'
```

Re-run the project's linter/formatter if it was part of the original
failure. All must exit 0 before reporting done.

### Step 4: Report

```
Fixed: Sendable conformance error in OrderCache
  - Root cause: OrderCache held mutable state accessed from two tasks
    with no isolation; converted it to an actor
  - xcodebuild build/test both pass, swiftlint clean
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause
  — never widen a fix beyond what the failure requires.
- NEVER mark a type `@unchecked Sendable` to silence a strict-
  concurrency error without stating, in the report, exactly why its
  mutable state is safe.
- NEVER force-unwrap (`!`) or force-try (`try!`) just to clear a
  compiler warning about an optional or a throwing call.
- NEVER add a blanket `// swiftlint:disable` (or disable a rule
  repository-wide) to make one finding disappear.
- NEVER delete or skip a failing test to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll mark this `@unchecked Sendable`, it's the fastest way to clear the error" | Trades a compile-time data-race guarantee for an unchecked promise; audit the actual access pattern or add real isolation instead |
| "I'll force-unwrap this to silence the compiler's optional-binding warning" | The warning exists because the compiler cannot prove the value is non-nil; force-unwrapping does not fix that, it just moves the failure to a runtime crash |
| "I'll add `// swiftlint:disable force_unwrapping` for this whole file" | Silences every future violation in the file, not just the one the fix addressed — scope any disable as narrowly as the actual justified exception |
| "This test is flaky, I'll mark it `.disabled()` for now" | Hides a real regression or a genuine flake worth fixing (non-deterministic async wait, shared state) instead of fixing the underlying cause |

## Verification

Do not report the fix done until all of the following hold:

- `xcodebuild build`/`swift build` and `xcodebuild test`/`swift test`
  both exit 0.
- The project's linter/formatter (if configured) exits 0.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
