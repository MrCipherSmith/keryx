---
name: kotlin-android-testing
description: "Use when a Kotlin/Android module's test suite needs writing, extending, or fixing -- runTest/TestDispatcher for suspend functions and ViewModels, ComposeTestRule semantics-based finders for UI tests, and MockK at the repository/data-source interface boundary."
triggers:
  - "write tests for this ViewModel"
  - "add a Compose UI test for this screen"
  - "fix this flaky Android test"
  - "test this suspend function"
  - "mock the repository for this unit test"
  - "cover this feature module with tests"
  - "the test for this screen keeps timing out"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Kotlin/Android testing

Write, extend, or fix a Kotlin/Android module's test suite: coroutine
tests with `runTest`/`TestDispatcher`, Compose UI tests with
`ComposeTestRule`, and interface-boundary mocking. `rules/testing.mdc`
carries the full rule set this skill's checklist is built from — read it,
not just this summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Read the module's `build.gradle(.kts)` test dependencies: MockK vs
   Mockito, `kotlinx-coroutines-test` version, and whether a Compose UI
   test dependency (`androidx.compose.ui:ui-test-junit4`) is present.
2. Find the layout: unit tests under `src/test/`, instrumented/Compose UI
   tests under `src/androidTest/`. Match whichever the module already
   uses; do not invent a third location.
3. Read 1-2 neighboring test files for: dispatcher-rule setup (a shared
   `MainDispatcherRule` or manual `Dispatchers.setMain`/`resetMain`),
   whether MockK or Mockito is standardized, and existing fixture/builder
   helpers for constructing test data.

### Step 2: Plan test cases

**`ViewModel`/suspend functions:** happy path, error/exception path from
a mocked dependency, and any intermediate state a caller can observe (a
loading state before a result arrives) using a `StandardTestDispatcher`
you advance explicitly.

**Compose UI:** initial render state, a user interaction
(`performClick()`, `performTextInput()`) and its resulting state/text
change, and a conditionally-shown element's visibility.

**Repository/data layer:** success and failure responses from the mocked
network/database boundary, and that a domain-level error type is what
actually reaches the caller (not a raw exception leaking through).

### Step 3: Write

1. Wrap coroutine test bodies in `runTest { }`; install a `TestDispatcher`
   for `Dispatchers.Main` via a shared JUnit rule (or manual
   `Dispatchers.setMain(...)`/`Dispatchers.resetMain()` in
   `@Before`/`@After`) so `viewModelScope` resolves to it.
2. Mock the `Repository`/`ApiService`/data-source interface the class
   under test depends on with MockK (`mockk<Repo>()`,
   `coEvery { repo.fetch() } returns result`) — never stub the class
   under test's own internals.
3. For a Compose UI test, use `createComposeRule()` (or
   `createAndroidComposeRule<Activity>()` when an Activity host is
   needed) and find nodes via `onNodeWithText`/
   `onNodeWithContentDescription`/`onNodeWithTag`, not structural
   indexing.
4. Advance the test dispatcher deliberately
   (`advanceUntilIdle()`/`runCurrent()`) at the point where the test
   needs to observe an intermediate or final state — never a fixed
   `delay`/`Thread.sleep` to "give it time."
5. Assert both the rendered/returned state and, where relevant, a
   `coVerify { repo.save(...) }` that the right interaction actually
   happened.

### Step 4: Run and fix

```bash
./gradlew testDebugUnitTest
```

Run `./gradlew connectedDebugAndroidTest` (or the project's Compose UI
test task) for instrumented tests when relevant. Fix failing tests (max 3
iterations) — fix the test, not the source under test, unless the test
itself has correctly caught a real bug (say so in the report rather than
silently changing production code).

### Step 5: Report

```
Generated: feature/profile/ProfileViewModelTest.kt
  - 6 cases (runTest + StandardTestDispatcher), repository mocked with MockK
  - ./gradlew testDebugUnitTest passes
```

## Rules

- ALWAYS match the project's existing dispatcher-rule and mocking-library
  conventions found in Step 1, not a different project's style.
- NEVER modify source code — only test files.
- NEVER use `Thread.sleep`/a fixed `delay` to wait for a coroutine or
  Compose UI update; use `runTest`'s virtual time, `advanceUntilIdle()`,
  or `composeTestRule.waitUntil { ... }`.
- Mock at the repository/data-source interface boundary, never the class
  under test's own private methods or fields.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add a short delay so the coroutine has time to finish" | Non-deterministic and slow; `runTest`'s virtual clock plus `advanceUntilIdle()` makes the wait both instant and deterministic |
| "I'll just mock a private method on the ViewModel itself to control what it returns" | Testing a mocked-out internal instead of real behavior; mock the repository/data-source interface the ViewModel actually depends on |
| "This UI test keeps flaking, I'll add a `Thread.sleep(500)` before the assertion" | Hides a real synchronization gap; use `composeTestRule.waitUntil { ... }` or advance the test dispatcher instead |
| "I'll loosen this assertion to just check the call didn't throw" | Covers nothing about which state or value resulted; assert the actual state/text/interaction outcome |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path
  (`src/test/`/`src/androidTest/`), matching Step 1's findings.
- `./gradlew testDebugUnitTest` (and the instrumented task, if touched)
  exits 0 with every generated test passing.
- `git status` shows only test files added or modified; no source file
  under test changed.
- No test synchronizes with `Thread.sleep`/a fixed `delay`.
