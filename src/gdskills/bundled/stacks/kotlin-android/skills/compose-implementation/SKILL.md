---
name: compose-implementation
description: "Use when implementing or extending a feature in a Kotlin/Android app with Jetpack Compose -- composable state hoisting, coroutine scopes (viewModelScope/lifecycleScope), StateFlow exposure from a ViewModel, and recomposition-safe side effects."
triggers:
  - "add this screen to our Android app with Compose"
  - "hook up this ViewModel to the new composable"
  - "wire a network call into this Android feature"
  - "build a form screen with validation for the app"
  - "expose loading/error state from the ViewModel to the UI"
  - "add a button that launches a coroutine to save data"
  - "implement this ticket in the mobile app's feature module"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Kotlin/Android (Jetpack Compose) implementation

Implement or extend a feature in a Kotlin/Android codebase built on
Jetpack Compose: composable structure, state hoisting, coroutine scope
choice, and state exposure from a `ViewModel`. Scoped to Kotlin/Android
specifically — `rules/coding-style.mdc`, `rules/patterns.mdc`, and
`rules/security.mdc` carry the full stack-specific rule set this skill
draws its checklist from; read them before writing code, not just this
summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read the module's `build.gradle(.kts)` for the Kotlin/AGP/Compose
   Compiler versions and which architecture libraries are already
   dependencies (`androidx.lifecycle:lifecycle-viewmodel-compose`,
   `kotlinx-coroutines-android`, Hilt/Koin/Dagger, Compose Navigation).
2. Find the existing layout: is this a single-module app or a
   feature-module setup (`:feature:profile`, `:core:ui`)? Match it; do
   not invent a different module boundary for one change.
3. Read 1-2 neighboring screens/`ViewModel`s in the feature you are
   touching for: state-holder naming (`UiState`, `ViewState`), whether
   state is exposed as `StateFlow` or still `LiveData`, the DI pattern in
   use, and whether a design-system component set already exists to
   reuse instead of building raw `Text`/`Button` composables.

### Step 2: Design before writing

- Decide, per new piece of state: does it belong in the `ViewModel`
  (survives configuration change, drives business logic) or hoisted only
  as far as the nearest composable ancestor that needs it (purely
  presentational, e.g. whether a dropdown is expanded)? Do not default
  everything into the `ViewModel` when a leaf composable's own `remember`
  is enough, and do not trap logic-relevant state in a composable when a
  sibling or rotation needs it to survive.
- Model the screen's state as a `sealed interface`/`data class` (a single
  `UiState` with a `sealed` status field, or a small sealed hierarchy for
  distinct screens like `Loading`/`Content`/`Error`) rather than several
  independent nullable/boolean fields the UI has to reconcile by hand.
- Decide the coroutine scope for any new asynchronous work before writing
  it: `viewModelScope` for anything driven from a `ViewModel`,
  `lifecycleScope`/`rememberCoroutineScope()` only for UI-only work with
  no `ViewModel` involved (an animation trigger, a one-off scroll). Never
  `GlobalScope`.
- Trace where any new side effect (navigation, a snackbar/analytics
  event, a suspend call) needs to run from — inside a composable body it
  belongs in `LaunchedEffect`/`DisposableEffect`, never as a bare
  statement.

### Step 3: Implement

1. Expose new `ViewModel` state as `private val _state =
   MutableStateFlow(...)` / `val state = _state.asStateFlow()`; collect
   it in Compose with `collectAsStateWithLifecycle()`.
2. Keep composable parameters stable (primitives, `data class`es of
   stable members, immutable collections) — strong skipping mode (default
   since Kotlin 2.0.20) lets the compiler skip even an unstable parameter
   via instance-identity comparison, but only a genuinely stable/immutable
   type can compare EQUAL across calls and actually skip when nothing
   changed; an unstable type rebuilt fresh each call still recomposes.
3. Hoist state per `rules/patterns.mdc`; use `remember`/`rememberSaveable`
   for composable-local state, never a `var` mutated directly inside the
   composable body outside of a `remember` holder.
4. Route any new side effect through `LaunchedEffect(key1, ...) { }` (with
   the correct key so it re-runs exactly when it should) or
   `DisposableEffect(key) { onDispose { ... } }` when cleanup is needed.
5. Launch new coroutine work in `viewModelScope`/`lifecycleScope` as
   decided in Step 2; wrap concurrent suspend calls in `coroutineScope { }`
   with `async`/`await` rather than firing untracked `launch` calls.
6. Avoid `!!`; use `?.`/`?:`/`requireNotNull(x) { "..." }` for any value
   that can be null (a nullable response field, an `Intent` extra, a
   `savedStateHandle` lookup).

### Step 4: Verify

```bash
./gradlew assembleDebug
./gradlew testDebugUnitTest
./gradlew lint
```

Run `./gradlew ktlintCheck` or `./gradlew detekt` if the project has one
configured. Fix findings at the root cause per `rules/security.mdc` and
`rules/coding-style.mdc`; a build/test/lint failure here is a signal to
fix the implementation, not to reach for `kotlin-android-build-fix`'s
scope unless the failure is purely a build/dependency/toolchain problem
unrelated to the feature logic.

### Step 5: Report

```
Implemented: feature/profile/ProfileViewModel.kt, feature/profile/ProfileScreen.kt
  - New ProfileUiState sealed hierarchy (Loading/Content/Error)
  - State exposed as StateFlow, collected with collectAsStateWithLifecycle()
  - Save action launched in viewModelScope
  - ./gradlew assembleDebug/testDebugUnitTest/lint all pass
```

## Rules

- Never launch a coroutine with `GlobalScope` — use `viewModelScope`,
  `lifecycleScope`, or a scope passed in by the caller.
- Never call a suspend function or fire a one-off UI event directly in a
  composable's body — use `LaunchedEffect`/`DisposableEffect`.
- Never expose a mutable `MutableStateFlow`/`MutableLiveData` from a
  `ViewModel`'s public surface — expose the read-only view.
- Never use `!!` to route around a null-safety warning; use a safe call,
  Elvis operator, or `requireNotNull` with a message.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just launch this in GlobalScope, it's a quick one-off network call" | Nothing cancels a GlobalScope coroutine when the screen/ViewModel is destroyed; it can still update state or navigate on a gone screen |
| "I'll call this suspend function right in the composable body, it only runs once" | A composable body can re-run on every recomposition; an uncontrolled suspend call outside LaunchedEffect can fire far more than once, or not track the right restart key |
| "I'll add `!!` here since this value is always set by the time we get here" | "Always" is an assumption the compiler cannot verify; a safe call or `requireNotNull` with a message documents and enforces the same assumption instead of crashing silently when it's wrong |
| "I'll just expose the MutableStateFlow directly, it saves a line" | Lets any collector outside the ViewModel push a new value, breaking the single-writer invariant the pattern exists to guarantee |

## Verification

Do not report the work done until all of the following hold:

- `./gradlew assembleDebug`, `./gradlew testDebugUnitTest`, and
  `./gradlew lint` all exit 0.
- Every new coroutine launch uses `viewModelScope`/`lifecycleScope`/a
  passed-in scope, never `GlobalScope`.
- Every new side effect inside a composable body runs through
  `LaunchedEffect`/`DisposableEffect`, not as a bare statement.
- Every new/touched `ViewModel`-exposed state is read-only from the UI's
  perspective (`StateFlow`/`SharedFlow`, not the mutable type).
