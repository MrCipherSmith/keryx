---
name: kotlin-android-code-review
description: "Use when reviewing a Kotlin/Android change for coroutine, Compose, and null-safety risks -- GlobalScope usage, side effects fired directly in a composable body, forced-unwrap on external data, mutable state leaked from a ViewModel, and exported manifest components. Read-only, no edits."
triggers:
  - "review this Android diff for coroutine leaks"
  - "check this Compose change for recomposition bugs"
  - "any null-safety issues in this Kotlin PR"
  - "review this ViewModel change for state leaks"
  - "check the manifest changes in this Android diff"
  - "review this mobile feature branch before merge"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Kotlin/Android code review

Read-only review of a Kotlin/Android change for coroutine, Compose, and
null-safety risks specific to this stack: unstructured coroutine scopes,
side effects fired outside `LaunchedEffect`/`DisposableEffect`, forced
null-unwraps on external data, leaked mutable state, and manifest
exposure. This skill never edits code — it reports findings.
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.kt`/`*.kts` files (and `AndroidManifest.xml` when
   touched) in the diff, not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed file against the focus list

**Coroutines**
- Any `GlobalScope.launch`/`GlobalScope.async` in the diff — flag it;
  the fix direction is `viewModelScope`/`lifecycleScope`/a passed-in
  scope.
- A new goroutine-equivalent (`launch`/`async`) with no scope tied to a
  lifecycle owner, or a fire-and-forget `launch` whose result/exception
  is silently dropped.
- A suspend call awaited with no cancellation awareness inside a loop
  that should stop early (missing `ensureActive()`/`isActive` check in a
  long-running or CPU-bound loop).

**Compose**
- A suspend call, navigation event, `Toast`, or analytics call written
  directly in a composable's body instead of inside `LaunchedEffect`/
  `DisposableEffect` — flag it; it can re-fire on every recomposition or
  run at the wrong time.
- A composable parameter of an unstable type (a plain mutable `List`, a
  class with public `var`s and no `@Stable`/`@Immutable`) in a
  performance-sensitive position (a `LazyColumn` item, a frequently
  recomposing parent) — flag as a likely recomposition-skip defeat.
- State read/written with a bare `var` inside a composable body with no
  `remember`/`rememberSaveable` wrapper — flag it; the value will not
  survive recomposition as intended.

**Null safety**
- `!!` on a value sourced from outside this function's own prior checks —
  a network response field, an `Intent` extra, a `savedStateHandle`
  lookup, a `find`/`firstOrNull` result — flag it; the fix direction is a
  safe call, Elvis operator, or `requireNotNull` with a message.

**State exposure**
- A `ViewModel` exposing a `MutableStateFlow`/`MutableLiveData` (not the
  read-only view) on its public surface — flag it; any collector outside
  the `ViewModel` can then push a new value.

**Manifest and security**
- A new or changed `<activity>`/`<service>`/`<receiver>`/`<provider>`
  entry with `android:exported="true"` and no permission attribute — flag
  it, and check whether the component actually needs to be reachable
  from other apps.
- A new credential/token written to plain `SharedPreferences` instead of
  `EncryptedSharedPreferences`/Keystore — flag it.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (leak, crash,
recomposition bug, data exposure), and the fix direction — but do not
apply it.

```
feature/profile/ProfileViewModel.kt:28 — GlobalScope.launch used to save
  the profile. Risk: outlives the ViewModel, can write state after the
  screen is gone. Fix direction: replace with viewModelScope.launch.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag GlobalScope usage, side effects outside LaunchedEffect/
  DisposableEffect, unstable composable parameters, `!!` on external
  data, leaked mutable ViewModel state, and unguarded exported manifest
  components; do not report generic style nits already covered by
  `ktlint`/`detekt`/`lint` (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected recomposition or leak issue is not certain from
  reading alone, say so and suggest a way to confirm (a Compose layout
  inspector trace, a `LeakCanary` run) rather than asserting it without
  evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This GlobalScope call is for a quick analytics ping, it's harmless" | Harmless intent doesn't change that nothing cancels it; flag it regardless of what the call does |
| "The `!!` here is fine, this field is always populated by the backend" | "Always" is an external contract, not a compiler-verified guarantee; report it as a finding, the API can still return the field as null once |
| "I'll just fix the exported manifest attribute myself, it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "The composable parameter type is a List, that's fine for now" | A raw `List` is not stable to the Compose compiler; flag it, especially in a list item or frequently-recomposing position |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.kt`/`*.kts` file (and `AndroidManifest.xml`, if
  touched) in the diff was read, not just files named in the PR
  description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
