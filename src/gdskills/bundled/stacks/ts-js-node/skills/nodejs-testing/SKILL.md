---
name: nodejs-testing
description: "Use when a Node.js project's test suite (node:test, Vitest, Jest, or bun test) needs writing, extending, or fixing for TypeScript or JavaScript server/library/CLI code -- covers discovering the project's actual runner, mocking at process boundaries, fake timers, and deterministic async assertions. Not for pytest/Python tests, and not for auditing test conventions without changing test files (that is review-testing-practices)."
triggers:
  - "write vitest tests for this service"
  - "add node:test coverage"
  - "fix failing jest test in this repo"
  - "mock fetch in this test"
  - "fake timers for this async test"
  - "add test coverage for this CLI command"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Node.js testing (node:test / Vitest / Jest / bun test)

Write, extend, or fix a Node.js project's test suite for TypeScript or
JavaScript server, library, or CLI code. The runner varies per project --
`node:test`, Vitest, Jest, and `bun test` are all in active use and are
not interchangeable in import source or config, so Step 1 always discovers
which one this project actually uses before anything is written. See
`rules/testing.mdc` for the full rule set.

## Workflow

### Step 1: Discover the project's test runner and conventions

1. Read `package.json`'s `scripts.test` and `devDependencies`
   (`vitest`, `jest`, or neither -> `node:test`/`bun test`), plus any
   `vitest.config.*`/`jest.config.*`.
2. Find the test layout: co-located `*.test.ts`/`*.spec.ts`, or a parallel
   `test/`/`__tests__/` tree. Match whichever the project already uses.
3. Read 1-2 neighboring test files for: import source of `describe`/`it`/
   `test`/`expect`/`assert`, mocking style, and how async tests are
   structured.

### Step 2: Plan mocks before test cases

- Mock at the process boundary only: network calls, filesystem, a DB
  client, `Date.now`/timers -- never an internal function one module away,
  which only checks two mocks agree with each other.
- For timer-dependent code, use the runner's fake timers (`node:test`'s
  `mock.timers`, Vitest's `vi.useFakeTimers()`, Jest's
  `jest.useFakeTimers()`) instead of a real `setTimeout` wait.
- Decide per dependency whether a hand-written stub or the runner's own
  mock helper (`mock.fn()`/`mock.method()`, `vi.fn()`, `jest.fn()`) is a
  better fit for the assertions needed.

### Step 3: Plan test cases

**Functions/handlers:** happy path, edge cases (empty/`null`/`undefined`/
boundary values), error cases asserting the specific thrown error type or
message (not just that something threw).

**Async code:** every assertion-relevant `await` present; a test that
returns before its promises settle reports green regardless of what the
assertions found.

**CLI commands:** exit code, stdout/stderr content, and behavior on
missing/invalid arguments.

**Cancelable operations:** pass the test's own `AbortSignal` (`t.signal` in
`node:test`, or the runner's equivalent) into any `fetch`/cancelable call
the test makes.

### Step 4: Write

1. Create/extend the test file at the project's own convention path and
   import source.
2. One assertion concept per test; a multi-assertion test states in its
   name the single behavior it verifies.
3. Each test sets up and tears down its own state -- no dependency on
   execution order or state a previous test left behind.

### Step 5: Run and fix

```bash
keryx test run --changed --strict
```

`src/testing/service.ts` detects the project's own configured runner from
its lockfile/scripts -- do not hard-code a runner's flags here beyond what
Step 1 already discovered. With no keryx testing config, run the project's
own configured test script instead (`npm test`, `npx vitest run`, `npx
jest`, `node --test`).

Fix failing tests (max 3 iterations) -- fix the test, not the source under
test.

### Step 6: Report

```
Generated: src/orders/orders.test.ts
  - 7 test cases (2 with fake timers), all passing
```

## Rules

- ALWAYS match the project's existing runner, layout, and mocking
  conventions found in Step 1-2, not a different project's test style.
- NEVER modify source code -- only test files (and test config/setup files
  when the change genuinely requires it).
- Mock external dependencies (network, filesystem, other services, the
  clock), not internal modules under the same package.
- If no test runner is configured at all, suggest adding one; do not add
  it unasked.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This async test doesn't need an await, the assertion is inside a `.then()`" | If the test function returns before the promise settles, the runner marks it passed regardless of what the assertion found |
| "I'll wait a real 2 seconds instead of mocking the timer" | Slow and, under load or CI contention, flaky; use the runner's fake timers |
| "The test keeps failing; I'll patch the source to make it pass" | This skill writes test files only -- a source change buried in a test-authoring run is an unreviewed fix that also hides the real bug |
| "I'll mock the internal helper so the test is simpler" | Mock external dependencies, not internal ones -- a test whose internal collaborators are all mocked only checks that the mocks agree with each other |
| "Still failing after three iterations; I'll loosen the assertion or skip it" | A loosened or skipped assertion covers nothing while reporting coverage. After 3 iterations, stop and report the failing case instead |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  runner and mocking style read in Step 1-2.
- `keryx test run --changed --strict` -- or, with no keryx testing config,
  the project's own discovered test command -- exits 0 with every
  generated test passing.
- No test depends on a real timer wait or on another test's leftover
  state.
- `git status` shows only test files (and test config, if genuinely
  touched) added or modified; no source file under test changed.
