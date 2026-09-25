---
name: vue-testing
description: "Use when a Vue 3 component or composable's test suite needs writing, extending, or fixing with Vue Test Utils and Vitest -- covers mount vs. shallowMount, querying by test id/role, awaiting trigger()/nextTick for async DOM updates, asserting wrapper.emitted() payloads, and Pinia test-store isolation with createTestingPinia. Not for plain Node.js/TypeScript unit tests with no .vue mount (use nodejs-testing) or React Testing Library tests (use react-testing)."
triggers:
  - "write a vitest test for this vue component"
  - "test this vue composable"
  - "fix this failing vue test utils test"
  - "mock the api call in this vue component test"
  - "assert the emitted event payload in this test"
  - "test this pinia store"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Vue testing (Vue Test Utils / Vitest)

Write, extend, or fix a Vue 3 component or composable test using Vue Test
Utils and Vitest. See `rules/testing.mdc` for the layout, querying, and
mocking conventions a correct test follows.

## Workflow

### Step 1: Discover the project's own test setup

- Read an existing `*.spec.ts`/`*.test.ts` next to a `.vue` file in the
  same directory (or the project's shared `__tests__` folder) to match
  its layout, its DOM environment (`happy-dom` vs `jsdom`), and whether it
  uses raw Vue Test Utils assertions or `@testing-library/vue` on top.
- Check whether the project uses Pinia and, if so, whether
  `@pinia/testing`'s `createTestingPinia()` is already a dependency --
  use it if present rather than hand-rolling store setup.
- Check the project's network-mocking convention (MSW, a mocked
  service/composable module, or `vi.mock()` on the fetch wrapper) and
  mock at that same boundary.

### Step 2: Choose mount depth and render the component

- `mount()` when the test cares about the full render tree, including
  child components' own output.
- `shallowMount()` only when child components are irrelevant noise for
  this test and stubbing them meaningfully clarifies the assertions.
- Pass every prop the assertions actually depend on explicitly through
  `mount(Component, { props: { ... } })` -- do not lean on a default
  silently covering a value the test cares about.

### Step 3: Interact and wait for reactivity to settle

- Trigger interaction with `await wrapper.find(selector).trigger('click')`
  (or `@testing-library/vue`'s `fireEvent`) -- always `await` it, since
  Vue's DOM updates are asynchronous (`flush: 'pre'` by default).
- After an async composable/store call the interaction kicks off, `await
  flushPromises()` (or the project's existing helper) plus `await
  nextTick()` before asserting on DOM that depends on it -- never an
  arbitrary `setTimeout`.

### Step 4: Assert behavior, not internals

- Assert on rendered text/attributes and `wrapper.emitted('eventName')`
  payloads, not on `wrapper.vm`'s internal reactive state -- `vm` access
  couples the test to implementation details that can change without
  changing behavior.
- When asserting an emitted event, check the payload array
  (`wrapper.emitted('update')![0]`), not just that the event key exists --
  a wrong payload with the right event name is still a real bug.

### Step 5: Verify

```bash
npx vitest run <path-to-spec>
npx vitest run
```

Run the full suite once the target file passes, to confirm the change did
not affect an unrelated test through shared Pinia/module state.

## Rules

- Follow `rules/testing.mdc` for layout, querying, Pinia isolation, and
  mocking boundaries.
- ALWAYS `await` a `trigger()`/`fireEvent` call and any subsequent DOM
  assertion that depends on it.
- ALWAYS give a component under test that reads a Pinia store a fresh
  test store instance (`createTestingPinia()` or a fresh `createPinia()` +
  `setActivePinia()`) -- never reuse one Pinia instance across tests.
- NEVER delete or loosen a failing assertion to make the suite green;
  fix the component if behavior regressed, or fix the assertion if it
  was asserting stale behavior, and say which.
- NEVER assert through `wrapper.vm.someInternalRef` when the same fact is
  observable through rendered output or an emitted event.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll skip the `await` on `trigger()`, the click is synchronous anyway" | Vue batches DOM updates asynchronously by default; the assertion right after an un-awaited trigger reads stale DOM and the test can pass for the wrong reason |
| "I'll just check `wrapper.emitted('update')` exists, not the payload" | A component that emits the right event with the wrong value still passes this assertion, hiding a real bug |
| "This test keeps failing on Pinia state from the previous test, I'll just reset it inside this one test" | The root cause is a shared store instance across tests; reset the store per-test globally (`beforeEach`) or use `createTestingPinia()`, not a one-off patch in the test that happened to notice |
| "I'll assert `wrapper.vm.count` directly, it's faster than finding the rendered text" | Couples the test to an internal variable name; a refactor that keeps behavior identical but renames the ref breaks the test for no real reason |

## Verification

Do not report the test done until all of the following hold:

- `npx vitest run` for the target file (and the full suite) exits 0.
- Every `trigger()`/`fireEvent` call is `await`ed, and no arbitrary
  `setTimeout` was used to wait for a DOM update.
- Every emitted-event assertion checks the payload, not just presence.
- A component reading a Pinia store gets its own fresh store instance in
  this test, not one shared with another test file.
- `git status` shows changes confined to the test file(s) the fix or new
  coverage required.
