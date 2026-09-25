---
name: flutter-testing
description: "Use when a Flutter app's test suite needs writing, extending, or fixing -- widget tests with testWidgets/WidgetTester, mocking the network/repository boundary with mocktail/mockito, and pump vs pumpAndSettle for animation- and async-aware assertions."
triggers:
  - "write widget tests for this Flutter screen"
  - "test this Flutter form's validation logic"
  - "add tests for this Flutter repository with a mocked HTTP client"
  - "fix this flaky Flutter widget test"
  - "test the loading and error states of this Flutter screen"
  - "add a test that taps this button and checks the result"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Flutter/Dart testing

Write, extend, or fix a Flutter app's `flutter_test`-based test suite:
widget tests, boundary mocking, and pump/settle discipline for
animation- and async-aware assertions. `rules/testing.mdc` carries the
full rule set this skill's checklist is built from — read it, not just
this summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Read `pubspec.yaml`'s `dev_dependencies` for the mocking library in use
   (`mocktail` or `mockito`) and the Dart/Flutter SDK constraint.
2. Find the layout: tests under `test/`, mirroring `lib/`. Read 1-2
   neighboring test files for fixture conventions, how ancestor widgets
   (`MaterialApp`, providers) are wrapped around the widget under test,
   and whether golden tests are already in use.
3. Identify the external boundary the widget/class under test actually
   depends on (a repository interface, an HTTP client wrapper, a
   platform-channel wrapper) — this is what gets mocked, not the widget's
   own internal collaborators.

### Step 2: Plan test cases

**Widgets:** initial render, each distinct visual state (loading / data /
empty / error), user interaction (`tap`/`enterText`/`drag`) and its
resulting state change, and any conditional rendering branch.

**Business logic (non-widget classes):** happy path, edge cases (empty/
null/boundary inputs), error cases from the mocked boundary.

**Async-state widgets:** the loading state immediately after
`pumpWidget()`, then the resolved state after the mocked `Future`/
`Stream` completes and a further `pump()`/`pumpAndSettle()`.

### Step 3: Write

1. Define an abstract interface for the external boundary if the codebase
   does not already have one (a `OrderRepository` abstract class an
   `HttpOrderRepository` implements) — this is what makes the boundary
   mockable without touching the widget's own internals.
2. Build the mock with `mocktail`'s `class MockOrderRepository extends
   Mock implements OrderRepository {}` (no codegen) or `mockito`'s
   `@GenerateMocks`/`@GenerateNiceMocks` (codegen), matching whichever the
   project already uses; stub calls with `when(...).thenAnswer(...)`
   (mocktail) or `when(...).thenReturn/thenAnswer` (mockito).
3. Wrap the widget under test in whatever ancestors it actually needs
   (`MaterialApp`, a provider scope) via `tester.pumpWidget(...)`, with the
   mocked boundary injected the same way the real app injects the real
   implementation (constructor parameter, provider override).
4. Locate elements with `find.text`/`find.byType`/`find.byKey`; drive
   interactions with `tester.tap`/`tester.enterText`/`tester.drag`.
5. Use `tester.pump()` for a single frame/animation step and
   `tester.pumpAndSettle()` once an animation, transition, or async
   operation should be fully finished before asserting — never a real-time
   `Future.delayed` wait; control the mocked `Future`/`Stream` directly.
6. Assert with `expect(find.text('...'), findsOneWidget)` /
   `findsNothing` / `findsNWidgets(n)`, and verify only the boundary
   interactions that matter to the behavior under test
   (`verify(() => mockRepository.fetchOrders()).called(1)`).

### Step 4: Run and fix

```bash
flutter test
```

Fix a failing test (max 3 iterations) by correcting the test or its
fixtures — not the widget/class under test — unless the test has
correctly caught a real bug, in which case say so in the report rather
than silently changing the implementation.

### Step 5: Report

```
Generated: test/order/order_screen_test.dart
  - 5 widget tests (loading/data/error/tap/empty), mocking
    OrderRepository with mocktail
  - flutter test passes
```

## Rules

- Mock the external boundary (repository/HTTP client/platform channel)
  behind an interface — never a widget's or class's own internal
  collaborators.
- Never use `Future.delayed`/a real time wait to give a mocked async call
  time to resolve; drive it with a controlled mock and `pump()`/
  `pumpAndSettle()`.
- Reach for `pumpAndSettle()` only when the pending animation/async work
  actually settles; use a bounded `pump(duration)` for anything driven by
  a repeating timer or an animation that never stops on its own.
- NEVER modify the widget/class under test to make a test pass — only test
  files and test fixtures, unless the test caught a real bug (say so).

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll mock the private `_formatOrder` helper this widget calls internally" | That is an internal collaborator, not the external boundary; mocking it tests that the widget calls its own helper a particular way, not that it produces correct behavior, and breaks on every internal refactor |
| "pumpAndSettle() times out, I'll just add a fixed pump(Duration(seconds: 2)) and move on" | A `pumpAndSettle()` timeout usually means something under test never stops animating (a repeating timer); reach for a bounded `pump(duration)` sized to the actual transition instead of guessing a delay that papers over the real cause |
| "I'll await Future.delayed(Duration(milliseconds: 500)) so the mocked repository call has time to resolve" | A mocked `Future` resolves whenever the test tells it to, not on a wall-clock delay; control the mock directly (or use `pump()`) so the test doesn't depend on timing |
| "wantErr-style boolean check is enough for the error state test" | Assert the actual rendered error content (`find.text('Failed to load orders')`), not just that some error branch was hit, so a wrong error message still fails the test |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, mirroring
  `lib/`.
- `flutter test` exits 0 with every generated/modified test passing.
- Every mock targets an external boundary interface, not an internal
  collaborator of the widget/class under test.
- No widget/class file under test was modified, unless the report
  explicitly states the test caught a real bug and names the fix.
