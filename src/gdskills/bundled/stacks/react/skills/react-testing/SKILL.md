---
name: react-testing
description: "Use when a React component's test suite needs writing, extending, or fixing with React Testing Library -- covers query-by-role/label, user-event interaction, async findBy/waitFor, network mocking at the request boundary, and act warnings, on top of the project's Vitest or Jest runner."
triggers:
  - "write a test for this component"
  - "test this react hook"
  - "fix this act warning"
  - "mock the api call in this component test"
  - "add react testing library test"
  - "write a react testing library test covering the loading and error states"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# React testing (React Testing Library)

Write, extend, or fix a React component or hook test using React Testing
Library on top of the project's own runner (Vitest or Jest). Scoped to
component-level testing through RTL's user-facing query/interaction model
— generic JS/TS unit testing with no component under test is
`ts-js-node`'s testing skill, and end-to-end browser testing (Playwright)
is a separate tool skill, not this one; see `governance/scout.json` for the
fork rationale.

## Workflow

### Step 1: Discover the project's test conventions

1. Confirm the runner (`vitest` or `jest`) from `package.json`
   scripts/deps, and that React Testing Library
   (`@testing-library/react`, `@testing-library/user-event`) is already a
   dependency — do not add Enzyme or introduce a second RTL version.
2. Find the layout: co-located `Component.test.tsx` next to the component,
   or a mirrored `__tests__` tree. Match whichever the project already
   uses.
3. Read 1-2 neighboring component tests for: render-helper conventions (a
   custom `render` wrapping providers), query style, and how network calls
   are mocked (MSW handlers, a manual fetch mock, or a mocked API client
   module).

### Step 2: Plan the states to cover

- Enumerate the component's rendered states: initial/loading, success,
  error, empty, and each conditional branch a prop or piece of state
  gates.
- For a form, cover: valid submit, validation error shown, pending state
  during submit, and the post-submit result (including an optimistic
  update if the component uses `useOptimistic`).
- For a custom hook with logic worth testing standalone, plan a
  `renderHook` test instead of mounting a throwaway component.

### Step 3: Write

1. Query by role/label/text (`getByRole`, `getByLabelText`, `getByText`);
   use `data-testid` only when no accessible query exists.
2. Drive interaction with `@testing-library/user-event`
   (`userEvent.setup()` then `.click`/`.type`/`.tab`), not `fireEvent`,
   unless the project's pinned `user-event` major cannot express it.
3. Wait for async UI with `findBy*` or `waitFor` — never a manual
   `setTimeout`.
4. Mock network calls at the request boundary (an MSW handler, or the
   project's existing equivalent), not by mocking the component's own
   data-fetching function — a boundary mock still exercises the real
   fetch/parse/error path.
5. Assert on rendered output and accessible state (text, role, `aria-*`),
   never on component internals, instance fields, or a snapshot of
   private props.

### Step 4: Run and fix

```bash
keryx test run --changed --strict
```

`src/testing/service.ts` detects the project's own configured runner — do
not hard-code `vitest`/`jest` flags beyond what Step 1 already found. On a
project with no keryx testing config, run the project's own configured
test command instead.

Fix failing tests (max 3 iterations) — fix the test, not the component
under test. An `act` warning means a state update escaped RTL's async
query wrapping; switch to the matching `findBy*`/`waitFor`, do not silence
the console.

### Step 5: Report

```
Generated: src/components/UserCard.test.tsx
  - 6 test cases (loading/success/error/empty + 2 interaction), all passing
```

## Rules

- ALWAYS query the way a user or assistive technology would (role/label/
  text) before falling back to `data-testid`.
- ALWAYS mock network at the request boundary, not the component's
  internal fetch wrapper.
- NEVER modify the component under test to make a test pass — file it as a
  separate implementation change (`react-implementation`) instead.
- NEVER replace `findBy*`/`waitFor` with a fixed `setTimeout`/`sleep`.
- If no RTL is configured, suggest adding it; do not add it unasked.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just grab it with a testid, querying by role is fiddly" | A `data-testid` fallback used by default stops the test from verifying the component is actually accessible; reach for it only when no accessible query exists |
| "This act warning is noisy, I'll wrap it in act() and move on" | An `act` warning usually means the test is not awaiting the right query; wrapping in `act` by hand without awaiting the real async work hides a real race instead of fixing it |
| "The test keeps failing on the loading state, I'll mock the component's fetch helper directly" | Mocking the internal helper skips the real request/parse/error-handling code path; mock at the network boundary (MSW or equivalent) instead |
| "Still red after three iterations; I'll change the component's markup to match the test" | This skill writes test files only — changing markup mid-test-authoring to force a pass is an unreviewed implementation change hiding as a test fix |
| "I'll snapshot the whole rendered tree, it's faster than writing assertions" | A full-tree snapshot passes on any change including regressions, and fails on cosmetic changes that carry no behavior signal — assert on the specific rendered output instead |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  query/mocking style read in Step 1.
- Every state enumerated in Step 2 has a corresponding passing test, or
  the report says why one is missing.
- No test reaches into component internals or asserts on a private prop.
- `keryx test run --changed --strict` — or the project's own discovered
  test command — exits 0 with every generated test passing.
- `git status` shows only test files (and a shared test-render helper, if
  touched) added or modified; no component source under test changed.
