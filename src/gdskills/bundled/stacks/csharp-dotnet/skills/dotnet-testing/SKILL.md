---
name: dotnet-testing
description: "Use when a C#/.NET test project needs writing, extending, or fixing -- xUnit/NUnit Fact/Theory and InlineData/TestCase tables, async test methods, and disciplined Moq/NSubstitute mocking that stubs external seams (HTTP, repository, clock) rather than internal collaborators."
triggers:
  - "write xUnit tests for this C# class"
  - "add Theory/InlineData cases for this method"
  - "fix this failing dotnet test"
  - "mock this HTTP client with Moq"
  - "write async test methods for this service"
  - "add NUnit TestCase coverage for this validator"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# .NET testing

Write, extend, or fix a C#/.NET test project's xUnit/NUnit test suite:
`Fact`/`Theory` (or `Test`/`TestCase`) structure, async test methods, and
disciplined mocking with Moq/NSubstitute. `rules/testing.mdc` carries the
full rule set this skill's checklist is built from — read it, not just
this summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Identify the test framework already in use (xUnit vs NUnit) from the
   test project's package references — match it; do not introduce a
   second framework.
2. Find the layout: a mirrored `*.Tests` project, existing naming
   pattern (`MethodName_Scenario_ExpectedResult`), and whether
   FluentAssertions or the framework's own `Assert` is already the house
   style.
3. Read 1-2 neighboring test files for: how mocks are constructed (Moq
   vs NSubstitute), which layer they mock at (a repository interface? an
   `HttpClient` wrapper?), and any shared fixture
   (`IClassFixture<T>`/`WebApplicationFactory<TEntryPoint>`) already in
   use.

### Step 2: Plan test cases

**Methods:** happy path, edge cases (null/empty/default-value inputs),
exception cases (assert the specific exception type and, where relevant,
its message/property), boundary values.

**Table-driven:** use `[Theory]`+`[InlineData(...)]` (xUnit) or
`[Test]`+`[TestCase(...)]` (NUnit) for one method exercised across
several input/expected-output pairs; reach for `[MemberData]`/a
`TestCaseSource` when a case needs a non-primitive argument.

**Async code:** a test method covering `async` production code is
itself `async Task`, never `async void`.

**Mocking boundary (the part most likely to go wrong):** identify which
collaborators are external seams (HTTP client, repository/database,
clock, message publisher) — those get mocked. Anything that is the unit
under test's own internal logic, split into a private helper or another
method of the same class for readability, is exercised for real, not
mocked out.

### Step 3: Write

1. Create/extend the test file at the project's own convention path
   (mirrored `*.Tests` project, matching namespace).
2. Construct mocks only for the external seam(s) identified in Step 2,
   via `Mock<IThing>` (Moq) or `Substitute.For<IThing>()` (NSubstitute).
3. Use `[Theory]`/`[TestCase]` tables for multi-case coverage instead of
   copy-pasted near-identical test methods.
4. Await the call under test in every async test; never block with
   `.Result`/`.Wait()`.
5. Verify a mock interaction (`mock.Verify(...)`) only when the
   occurrence itself is part of the contract being tested.

### Step 4: Run and fix

```bash
dotnet test
```

Fix failing tests (max 3 iterations) — fix the test, not the source
under test, unless the test itself has correctly caught a real bug (say
so in the report rather than silently changing production code).

### Step 5: Report

```
Generated: src/Orders.Tests/OrderServiceTests.cs
  - 7 test cases (4 via Theory/InlineData), all passing
  - Mocked IOrderRepository (external seam); OrderService's own
    validation logic exercised directly, not mocked
```

## Rules

- ALWAYS match the project's existing framework, naming, and assertion
  conventions found in Step 1, not a different project's style.
- NEVER mock an internal collaborator that is part of what the test is
  meant to verify — only mock a genuine external seam (HTTP, database,
  filesystem, clock, message bus).
- NEVER use `async void` for a test method, or block on `.Result`/
  `.Wait()` instead of `await`ing the call under test.
- NEVER synchronize with `Thread.Sleep`/`Task.Delay` to wait for
  background/async work — await the real `Task` or a real
  synchronization primitive.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll mock the private validation helper too, it's easier than setting up real inputs" | That helper is part of the unit under test; mocking it proves only that your mock returns what you told it to, not that the real logic works |
| "I'll write this test method as `async void`, it's simpler" | The test runner cannot await it, so a failing assertion or thrown exception inside it is silently lost instead of failing the test |
| "I'll add a short `Task.Delay(200)` so the background operation finishes before I assert" | Non-deterministic and flaky under load; await the actual `Task` or a real completion signal instead |
| "I'll just check `Assert.NotNull(result)` for the error case instead of the specific exception type" | Loses exactly which failure occurred; assert the specific exception type (and relevant properties/message) so a regression in *which* error occurs is caught |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  framework and naming style read in Step 1.
- `dotnet test` exits 0 with every generated test passing.
- Every mock constructed in the new/changed tests is for a genuine
  external seam, not an internal collaborator of the unit under test.
- `git status` shows only test files added or modified; no source file
  under test changed (unless a real bug the test caught was fixed and
  called out explicitly in the report).
