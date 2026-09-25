---
name: swift-testing
description: "Use when a Swift/iOS test suite needs writing, extending, or fixing -- Swift Testing's @Test/#expect/#require, parameterized tests, legacy XCTest, and mocking network/persistence dependencies at a protocol boundary rather than the type under test's internals."
triggers:
  - "write tests for this Swift function"
  - "add Swift Testing coverage for this view model"
  - "fix this failing XCTest"
  - "add a parameterized test with arguments"
  - "mock the network layer for this test"
  - "test this async Swift function"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Swift/iOS testing

Write, extend, or fix a Swift test suite: Swift Testing (`@Test`/
`#expect`/`#require`) for new coverage, legacy `XCTest` where a project
has not migrated, and mocking external dependencies at a protocol
boundary. `rules/testing.mdc` carries the full rule set this skill's
checklist is built from — read it, not just this summary, before writing
tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Check whether the test target already imports `Testing` (Swift
   Testing) or is built on `XCTestCase` (legacy XCTest) — match
   whichever the target already uses for the kind of test you are
   adding; introduce Swift Testing for new unit-test coverage rather
   than mixing frameworks within one file.
2. Read 1-2 neighboring test files for: naming convention, how mocks/
   test doubles are constructed, and whether a protocol boundary already
   exists for the dependency you need to fake.
3. Note anything the test subject needs isolated to `@MainActor` — a
   test exercising `@MainActor`-isolated state needs the same isolation
   on the test itself.

### Step 2: Plan test cases

**Functions:** happy path, edge cases (nil/empty/boundary inputs), error
cases (the specific error thrown, not just "it throws"), async
cancellation where relevant.

**Parameterized (Swift Testing):** `@Test("description", arguments:
[...])` over a hand-rolled loop or several copy-pasted test functions
that differ only by input.

**Dependencies (network, persistence, platform services):** identify the
protocol boundary the production code already depends on (or define one
if it does not exist yet) and construct a test double conforming to that
protocol — never mock the type under test's own private methods or
internal collaborators.

### Step 3: Write

1. Create/extend the test file at the project's own convention path and
   framework (`Testing` or `XCTestCase`).
2. `@Test func name() async throws { ... }` with `#expect(...)` for
   checks that should record and continue, `try #require(...)` for ones
   that must stop the test immediately (Swift Testing); or the XCTest
   equivalents (`XCTAssert...`, `XCTUnwrap`) on a legacy target.
3. Inject the protocol-typed test double into the type under test
   through its existing initializer/dependency-injection point — do not
   reach into private state to swap a dependency.
4. Await async calls directly (`await`) instead of bridging with
   `XCTestExpectation`/a semaphore, unless the project's toolchain
   predates async test support.
5. Never wait for concurrent work with a fixed delay
   (`Thread.sleep`/`Task.sleep` as a guess); await the call, join a
   `TaskGroup`, or await a real fulfillment signal.

### Step 4: Run and fix

```bash
xcodebuild test -scheme <Scheme> -destination 'platform=iOS Simulator,name=<Simulator>'
# or, for a Swift package:
swift test
```

Fix failing tests (max 3 iterations) — fix the test, not the source
under test, unless the test itself has correctly caught a real bug (say
so in the report rather than silently changing production code).

### Step 5: Report

```
Generated: OrderDetailModelTests.swift
  - 6 @Test functions (2 parameterized), OrderClient mocked at its protocol boundary
  - xcodebuild test passes
```

## Rules

- ALWAYS match the project's existing framework (Swift Testing vs
  XCTest) and naming/mock conventions found in Step 1, not a different
  project's style.
- NEVER modify source code — only test files (and test doubles/fixtures
  alongside them).
- NEVER mock a dependency below its protocol boundary — fake the
  protocol (network client, persistence layer), not the type under
  test's own internals or private state.
- NEVER use a fixed delay (`Thread.sleep`/`Task.sleep` as a guess) to
  wait for async/concurrent work to finish.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just stub the private `fetchFromDisk()` method on the view model itself" | Mocking a type's own internals couples the test to an implementation detail; it breaks on a harmless refactor and proves nothing about the type's real, protocol-shaped dependency |
| "A short `Task.sleep(for: .milliseconds(200))` should be enough for the async call to finish" | Non-deterministic under load/CI; `await` the call directly or join the real completion signal instead of guessing a duration |
| "This test keeps failing, I'll loosen the assertion to just check `result != nil`" | Covers nothing about *what* the result should be, hiding a regression next time this test should have caught one |
| "It's simpler to keep using XCTestCase for this new test even though the rest of the target moved to Swift Testing" | Match what the target has actually adopted; mixing frameworks within one file/target without a reason adds inconsistency for no benefit |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  framework and style read in Step 1.
- `xcodebuild test`/`swift test` exits 0 with every generated test
  passing.
- Any faked dependency conforms to the same protocol the production code
  depends on — not a subclass override or a private-method stub.
- `git status` shows only test files (and test doubles/fixtures) added
  or modified; no source file under test changed.
