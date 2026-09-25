---
name: nextjs-nuxt-testing
description: "Use when writing or fixing tests for a Next.js App Router page/Server Action or a Nuxt page/composable/server route: testing a Server Component's rendered output, a Client Component's interactivity with React Testing Library, a Nuxt composable that calls useFetch/useAsyncData with @nuxt/test-utils' mountSuspended, or a server/api handler's auth and validation paths. Not for plain React/Vue component unit tests with no meta-framework routing, SSR, or server-route concern (use react-testing/vue-testing), and not for implementing the feature under test (use nextjs-nuxt-implementation)."
triggers:
  - "write a test for this Next.js server action"
  - "test this Nuxt composable that uses useAsyncData"
  - "mountSuspended test for this Nuxt component with auto-imports"
  - "how do I test a Next.js server component's output"
  - "write a test for this server/api route in Nuxt"
  - "test this route handler's auth check in Next.js"
  - "flaky test around Date.now in this Next.js page"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Next.js / Nuxt testing

Write or fix a test for a Next.js App Router page/Server Action or a Nuxt
page/composable/server route. Covers both frameworks' own test-runner
setup and mocking conventions. See `rules/testing.mdc` for the layout and
mocking rules this skill applies.

## Workflow

### Step 1: Identify what is actually under test

- A Server Component's rendered output (no interactivity) vs. a Client
  Component's behavior (event handlers, state) vs. a Server
  Action/route handler's logic (validation, auth, the mutation itself) —
  each needs a different test shape; do not force all three through one
  `render()` call.
- A Nuxt page/composable that calls `useFetch`/`useAsyncData`/another
  Nuxt-context composable, vs. a plain presentational `.vue` component
  with no Nuxt runtime dependency — the first needs Nuxt's test context,
  the second does not.

### Step 2: Pick the right harness

- Next.js: React Testing Library (with Jest or Vitest, whichever the
  project already runs) for a Client Component's interactivity. For a
  Server Component, render its resolved output or exercise it through an
  integration/e2e test — `render()` alone does not run the App Router's
  server data-fetching lifecycle.
- Nuxt: `@nuxt/test-utils`'s `mountSuspended` (or `renderSuspended`) for
  any component that calls a Nuxt composable needing runtime context;
  plain Vue Test Utils `mount()` only for a component with zero Nuxt
  context dependency.
- A Server Action or `server/api/**` handler: call the exported function
  directly with a constructed request/args, not through a rendered
  component — the goal is testing the handler's own logic in isolation.

### Step 3: Mock at the network boundary, not the data-fetching hook

- Mock HTTP with MSW (or the project's existing network mock layer) for
  any test that exercises `fetch`/`useFetch`/`$fetch` — this exercises the
  real request/response handling code instead of a hand-stubbed hook
  return value.
- For a Server Action/server route test, mock the downstream dependency
  (DB client, external API client) one layer down, and call the real
  handler on top of it, so the test actually proves the handler's
  auth/validation logic runs.

### Step 4: Make it deterministic

- Freeze/inject time (`vi.setSystemTime`, a clock parameter) for anything
  rendering `Date.now()` or locale-dependent output.
- Build route params/`searchParams`/`useRoute()` mocks with a realistic
  shape (a fixture/factory), not a hand-built partial object that
  happens to satisfy today's assertions.

### Step 5: Verify

Run the project's test command and confirm the new test fails without the
implementation and passes with it (or, for a bug-fix test, fails on the
buggy code first).

## Rules

- Follow `rules/testing.mdc` for layout, runner choice, and network
  mocking.
- Test the Server Action/server route's own auth and validation failure
  paths, not just its success path.
- NEVER mock the framework's data-fetching hook itself
  (`useFetch`/`useAsyncData`) to return canned data when the point of the
  test is the component's request/response handling — mock the network
  layer beneath it instead.
- NEVER skip or delete a flaky SSR/hydration-dependent test instead of
  fixing its nondeterminism (freeze time, mock the varying input).

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just mock useAsyncData to return the data directly, simpler than mocking the network" | Tests the mock, not the component's real fetch/error/loading handling; mock at the network boundary instead |
| "This composable test keeps breaking on Nuxt context, I'll just plain-mount it with Vue Test Utils" | A composable that needs Nuxt's injection context needs `mountSuspended`/Nuxt's test context, not a mount that has none |
| "This test is flaky because of the date, I'll just skip it" | Skipping hides the same nondeterminism that causes a real hydration mismatch in production; freeze the clock instead |
| "The server action already has client-side validation tested, no need to test the handler separately" | The handler is a directly reachable endpoint; its own validation/auth path needs its own test regardless of client-side coverage |

## Verification

Do not report the test done until:

- The project's test command passes, and the new test fails against the
  pre-fix/pre-implementation code (proving it actually exercises the
  behavior).
- No data-fetching hook (`useFetch`/`useAsyncData`/`fetch`) was mocked
  directly when a network-boundary mock (MSW or equivalent) would have
  exercised the real code path.
- A tested Server Action/server route has at least one assertion covering
  an auth or validation failure, not only the happy path.
- No `Date.now()`/`Math.random()`/locale-dependent value reaches an
  assertion unfrozen or unmocked.
