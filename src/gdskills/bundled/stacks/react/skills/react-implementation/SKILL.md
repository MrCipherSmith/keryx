---
name: react-implementation
description: "Use when building or changing a React component, hook, or form in a .tsx/.jsx file -- covers function components, deriving state instead of syncing it with effects, Suspense and error boundaries, form Actions (useActionState, useOptimistic, useTransition), ref-as-prop, and React Compiler-aware memoization."
triggers:
  - "build a react component"
  - "add a hook to this component"
  - "convert this form to use an action"
  - "this react component re-renders too often, memoize it or check the compiler"
  - "add suspense boundary"
  - "wire up useOptimistic"
  - "when should this be a react server component vs a client component"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# React implementation

Build or change a React component, hook, or form in `.tsx`/`.jsx` files,
following current (React 19-era) practice. Scoped to React's own component
model — generic TypeScript/Node authoring (module structure, error
handling, non-component logic) is `ts-js-node`'s implementation skill, not
this one; see `governance/scout.json` for why this needed its own skill
rather than a fork.

## Workflow

### Step 1: Discover the project's React conventions

1. Check the React major in use (`package.json`'s `react`/`react-dom`
   version) and whether the React Compiler is enabled (a
   `babel-plugin-react-compiler`/`react-compiler` dependency or babel/swc
   config entry) — this changes whether manual memoization is wanted.
2. Identify the framework, if any (Next.js/Remix/plain Vite/CRA-successor)
   — it determines whether server/client components and Actions exist as a
   concept in this project at all.
3. Read 1-2 neighboring components for: function-vs-class (should always
   be function for new code), props-typing style, state-management library
   in use (plain hooks, MobX, Redux, Zustand, Jotai), and file/test
   co-location.
4. If a state-management library is in use for this component's slice of
   state, defer to that library's own conventions for where state lives —
   this skill covers React's own hook/effect/render model, not a specific
   store library's API.

### Step 2: Design the component

- Decide what is props, what is local state, and what is derived — a
  value computable from existing props/state during render is not state
  (`rules/patterns.mdc`, "Derive, don't sync").
- Decide what needs an effect: only synchronization with something outside
  React (subscription, DOM measurement, non-React widget, browser storage).
  A data fetch has a better home when the framework offers one
  (a loader, a server component, a query library) — reach for a bare
  `useEffect` fetch only when the project has none of those.
- For a form, decide upfront whether it needs a pending/optimistic/error
  UI. If so, plan for `<form action={...}>` + `useActionState` (+
  `useOptimistic` for the optimistic path) instead of manual submit-handler
  state.
- For a component the caller may need to focus, measure, or imperatively
  control, accept `ref` as an ordinary prop (React 19) rather than wrapping
  in `forwardRef`, unless the project is still on React 18 or earlier.

### Step 3: Implement

1. Function component, typed props via `interface`/`type` (not `React.FC`).
2. Keep hooks unconditional and top-level (`rules/coding-style.mdc`).
3. Give every list item a stable, data-derived `key`.
4. Wrap an async read (`use(promise)` or a data-fetching boundary) with a
   `Suspense` fallback for the pending state and an error boundary for the
   rejected state.
5. In a server/client-component framework, keep data fetching and secrets
   in server components; add `"use client"` only to the leaf that actually
   needs state, effects, refs, or browser APIs.
6. Apply `rules/security.mdc` to anything touching `dangerouslySetInnerHTML`,
   a dynamic `href`/`src`, or a public-env-prefixed variable.
7. Only add `memo`/`useMemo`/`useCallback` for a measured re-render cost
   when the React Compiler is NOT enabled for this project (Step 1); when
   it is enabled, let the compiler handle memoization.

### Step 4: Verify

```bash
keryx test run --changed --strict
```

Run the project's own type-check and lint (with the `react-hooks` plugin)
if `keryx test run` does not already cover them. Fix failures by changing
the component, not by loosening a type or disabling a hooks-lint rule.

### Step 5: Report

```
Changed: src/components/UserCard.tsx
  - converted local sync-effect to a derived value
  - added useActionState for the save form
  - tests: keryx test run --changed --strict passing
```

## Rules

- ALWAYS derive a value from existing props/state during render instead of
  syncing it into state via an effect, when the value is computable
  without an external round-trip.
- ALWAYS give hooks a stable call order — no hook inside a condition, loop,
  or callback.
- NEVER use the array index as a list `key` when the list can reorder,
  filter, or insert.
- NEVER pass unsanitized user-sourced HTML to `dangerouslySetInnerHTML`
  (`rules/security.mdc`).
- Match the project's existing state-management library instead of
  introducing a second one for one component.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add a useEffect that calls setState whenever this prop changes" | Almost always a derivable value or a `key`-based remount, not an effect — an effect that only mirrors state adds a render, a flash of stale UI, and a dependency-array bug surface |
| "This list is short, index as key is fine" | A short list can still reorder or have items removed; index keys corrupt component identity and local state (input focus, animation) across a reorder |
| "The compiler is on but I'll wrap it in useMemo anyway, can't hurt" | Manual memoization on compiled code is dead weight and can hide a case the compiler would otherwise have caught cleanly — trust the compiler when it is enabled |
| "I'll sanitize this HTML string somewhere upstream, not right here" | A sanitize step far from the sink is one refactor away from being silently dropped; sanitize immediately before the `dangerouslySetInnerHTML` prop is built |
| "I'll just cast this ref/event to any, the types are being annoying" | The types changed on purpose in recent React majors (ref-as-prop, stricter event types); route through `react-build-fix` to fix the real typing instead of casting away the check |

## Verification

Do not report the work done until all of the following hold:

- No hook is called conditionally, in a loop, or after an early return —
  order is identical on every render.
- Every list `.map` render has a stable, data-derived `key`.
- Any effect added is synchronizing with something outside React, not
  mirroring existing props/state into a second state value.
- `dangerouslySetInnerHTML`, if used, sanitizes input immediately before
  the prop is built (`rules/security.mdc`).
- `keryx test run --changed --strict` (or the project's own type-check +
  lint + test commands) exits 0.
- `git status` shows only the intended component/hook/test files changed.
