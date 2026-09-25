---
name: swift-code-review
description: "Use when reviewing a Swift/iOS change for concurrency, memory, and safety risks -- force-unwraps, retain cycles from closures capturing self, missing @MainActor isolation, @unchecked Sendable used to silence checks, and secrets stored outside the Keychain. Read-only, no edits."
triggers:
  - "review this Swift diff for force unwraps"
  - "check this iOS change for retain cycles"
  - "review this SwiftUI pull request for concurrency issues"
  - "any Keychain misuse in this Swift change"
  - "check @MainActor isolation in this diff"
  - "review this Swift diff for Sendable violations"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Swift/iOS code review

Read-only review of a Swift/iOS change for concurrency, memory, and
safety risks specific to Swift: force-unwraps, retain cycles, missing
actor isolation, concurrency-check suppressions, and secret storage. This
skill never edits code — it reports findings. `rules/coding-style.mdc`,
`rules/patterns.mdc`, and `rules/security.mdc` are the rule set findings
are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.swift` files in the diff, not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed file against the focus list

**Optionals and force operations**
- A force-unwrap (`!`) or force-try (`try!`) on a value that is not a
  guaranteed-safe programmer invariant (a network response, decoded
  JSON, user input, anything from an external source) — flag it and
  suggest `guard let`/`if let`/`try?`/explicit error handling instead.

**Concurrency and actor isolation**
- An `@Observable` class or any type whose state SwiftUI reads/mutates
  is not isolated to `@MainActor` — flag the missing isolation as a
  potential cross-actor data race.
- `@unchecked Sendable` or `nonisolated(unsafe)` applied without a
  comment justifying why the type's mutable state is actually safe —
  flag it as a suppression rather than a proven-safe boundary.
- A `Task {}` started with no stated reason it does not need to be
  joined/cancelled, especially one that should be scoped to a view's
  lifetime via `.task` instead of created manually — flag it.

**Memory and closures**
- A closure that outlives its creating call (stored callback, Combine
  `sink`, a `Task` capturing a long-lived object) capturing `self`
  strongly where that creates a retain cycle — flag a missing `[weak
  self]`; distinguish it from a short-lived closure that returns before
  the enclosing scope does, which does not need one.

**State ownership**
- `@State` used for a value that is actually owned and mutated by a
  parent (should be `@Binding`), or a `@StateObject`/`ObservableObject`
  created inline inside a view's body (recreated on every update
  instead of owned once) — flag either as a state-ownership bug per
  `rules/patterns.mdc`.

**Security**
- A secret, API key, or auth token stored in `UserDefaults`, hardcoded
  as a string literal, or logged unredacted — flag per
  `rules/security.mdc`.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (crash risk,
data race, leak, secret exposure), and the fix direction — but do not
apply it.

```
Features/Order/OrderDetailModel.swift:18 — force-unwraps `response.items.first!`
  on a decoded network response. Risk: a genuinely empty or malformed
  response crashes the app instead of failing gracefully. Fix direction:
  `guard let first = response.items.first else { throw ... }`.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag force-unwraps/force-tries on non-guaranteed values, missing
  `@MainActor` isolation, `@unchecked Sendable` suppressions, retain
  cycles, state-ownership bugs, and secrets outside the Keychain; do not
  report generic style nits already covered by SwiftLint/swift-format
  (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected data race is not certain from reading alone, say "run
  under Thread Sanitizer / the Swift 6 strict-concurrency checker to
  confirm" rather than asserting a race exists without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The API always returns this field, the force-unwrap is fine" | "Always" is a claim about a system outside this diff's control; a malformed or versioned response crashes instead of failing gracefully |
| "This closure fires fast, `self` won't actually leak" | A retain cycle does not depend on how fast a closure fires — if it is stored or can outlive the call, an unweakened `self` capture leaks regardless |
| "`@unchecked Sendable` here is just to get the build green, we'll revisit it" | An unchecked promise with no audit trail rarely gets revisited; ask for the actual safety argument now or flag it as unresolved |
| "I'll just fix the force-unwrap myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.swift` file in the diff was read, not just files
  named in the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
