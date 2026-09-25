---
name: mobx-observable-testing
description: "Use when writing or fixing a test for a MobX store: asserting on an async action's post-await state, waiting for a reaction/autorun to fire, testing that dispose() actually stops a store's reactions, or deciding how enforceActions should behave in the test setup. Distinct from rendering-focused React component testing and generic Node/TypeScript test-runner setup. Not for writing the store or action code itself (use mobx-store-implementation) and not for React Testing Library render/interaction patterns with no MobX involved (use react-testing)."
triggers:
  - "write a test for this MobX store's async fetch action"
  - "test that this store's reaction actually fires"
  - "my store test asserts before the async action finishes"
  - "test that dispose() stops this store's autorun"
  - "how should enforceActions behave in tests"
  - "test this computed getter updates when the observable changes"
  - "flaky MobX store test that sometimes reads stale state"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# MobX observable testing

Write or fix a test that exercises a MobX store's actions, computed
values, or reactions directly — not through a component render. See
`rules/testing.mdc` for the full set of conventions this skill applies,
and `rules/patterns.mdc` for the async-action shape being tested.

## Scope

This skill is for testing MobX's own reactivity: does an action correctly
update state, does a computed recompute, does a reaction fire and get
disposed. It is not for writing the store/action code under test (use
`mobx-store-implementation`) and not for React Testing Library
render/interaction mechanics with no MobX-specific concern (use the
`react` pack's testing skill) — a test that only checks a button click
calls a prop handler has nothing MobX-specific in it and does not need
this skill.

## Workflow

### Step 1: Identify what kind of MobX behavior is under test

- A synchronous action's effect on observable state — assert immediately
  after calling it.
- An async action's effect on state after an `await` — the assertion has
  to wait for the action's own promise (or a predicate) to resolve, not
  run synchronously.
- A `@computed` getter — assert it changes when its own observable
  dependency changes, and does not change when an unrelated field does.
- A `reaction`/`autorun`/`when` — assert its effect actually runs after
  the triggering mutation, and stops running after `dispose()`.

### Step 2: Construct the store with mocked dependencies

Instantiate the store directly with mocked injected dependencies (an API
service stub), not a full component tree. Keep `enforceActions` at the
project's real setting (see `rules/testing.mdc`) — do not loosen it in
test setup just to make an assertion easier to write.

### Step 3: Write the assertion with the right wait

- Sync action: call it, assert immediately.
- Async action: `await` the action's returned promise directly if it's a
  plain `async` method; otherwise `await when(() => <the condition the
  action should reach>)` before asserting.
- Reaction/autorun: trigger the mutation that should fire it, then
  `await when(() => <the reaction's expected effect>)` (or `await
  Promise.resolve()` for a synchronous microtask reaction) before
  asserting the effect ran.
- Never assert immediately after a mutation that a reaction depends on
  without first waiting for that reaction to run, and never paper over a
  flaky wait with a fixed `setTimeout`/sleep — it is both slower and
  still not deterministic under load.

### Step 4: Test disposal

For a store owning `autorun`/`reaction`/`when`, add a test that calls
`dispose()`, then triggers the mutation that would normally fire the
reaction, and asserts the reaction's effect did NOT run again — a test
that only checks `dispose()` doesn't throw misses the actual leak.

### Step 5: Verify

Run the project's test command and confirm the new/changed tests are
deterministic (run them a few times in a row locally if they involve
timing) and pass without a suppressed assertion.

## Rules

- Follow `rules/testing.mdc` for store test layout, mocking, and
  `enforceActions` behavior.
- ALWAYS wait for an async action's own completion (its promise, or a
  `when(...)` predicate) before asserting on state it sets — never assert
  synchronously right after calling it.
- ALWAYS keep `enforceActions` at the project's real setting; seed
  precondition state through `runInAction`, not by disabling it.
- NEVER assert on a reaction's effect without first waiting for the
  reaction to actually run.
- NEVER skip or delete a store test to make a suite pass; fix the source
  if behavior regressed, or fix the test if its expectation was stale —
  state which, and why.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just add a `setTimeout(resolve, 100)` before asserting, it's fast enough in CI" | A fixed sleep is both slower than necessary and still not deterministic under load; wait on the action's own promise or a `when(...)` predicate instead |
| "I'll set `enforceActions: 'never'` in the test file so I can mutate state directly to set up my fixture" | That hides the same bug class the real app would hit; seed fixture state through `runInAction` instead |
| "The dispose() test just checks it doesn't throw, that's enough" | A store can dispose without ever having wired up its reactions correctly; assert the reaction's effect actually stops firing after dispose |
| "This store test is flaky, I'll skip it for now" | Skipping hides a real timing bug in the store or the test's own wait strategy; find the missing `await`/`when` instead |

## Verification

Do not report a store test done until all of the following hold:

- The project's test command passes for the new/changed test.
- Every assertion on async-action or reaction state waits for that
  action's promise or a `when(...)` predicate first — no bare
  `setTimeout`/sleep.
- `enforceActions` was not loosened in the test file to make setup
  easier.
- A store owning disposable reactions has a test proving `dispose()`
  actually stops them, not just that it runs without throwing.
- Re-running the test locally 2-3 times in a row produces the same
  result (no flake from a missing wait).
