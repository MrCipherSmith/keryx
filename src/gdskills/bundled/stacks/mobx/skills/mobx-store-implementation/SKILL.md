---
name: mobx-store-implementation
description: "Use when writing or extending a MobX store: adding observable state, actions, computed getters, or reactions (autorun/reaction/when), wiring a store into React via observer and a context hook, or fixing a component that stops re-rendering after a store change. Also covers plain-language asks for the same work: keeping a piece of MobX store state automatically in sync wherever it's read, or making a store run something automatically when a value changes and stop when the store is no longer needed. Applies the makeObservable/action/runInAction/observer shape and the store's dispose lifecycle. Not for reviewing an already-written store's structure (use code-mobx-store-review) and not for plain React state/props work with no MobX involved (use react-implementation)."
triggers:
  - "add a new observable field to this MobX store"
  - "write a MobX action for this store"
  - "wire this store up with observer and a context hook"
  - "this component doesn't re-render when the store changes"
  - "add a computed getter to this store"
  - "set up a reaction that disposes when the store unmounts"
  - "create a new MobX store for this feature"
  - "make this async store method update state correctly"
  - "keep this piece of MobX store state automatically in sync wherever it's read"
  - "make this store run something automatically when a value changes and stop when the store is no longer needed"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# MobX store implementation

Write or extend a MobX store: observable state, actions, computed
getters, reactions, and the React wiring (`observer` + context hook) that
connects it to components. See `rules/coding-style.mdc` for the store
shape and `rules/patterns.mdc` for the async-action and reaction-disposal
patterns this skill applies.

## Scope

This skill is for **authoring** store code — a new store, a new
observable/action/computed on an existing store, a new reaction, or the
`observer`/context wiring that exposes a store to components. It is not
for auditing an already-written store's structure or accessibility
modifiers (`code-mobx-store-review` does that), and it does not cover
plain React component work that touches no MobX API.

## Workflow

### Step 1: Find the project's own store conventions

Before writing anything, look at 1-2 existing stores in the project (or
`rules/coding-style.mdc`'s minimal template if none exist yet) for:

- whether the project uses `makeObservable` with explicit annotations or
  `makeAutoObservable`,
- the store's file/class naming (`xyz.store.ts` / `XyzStore`),
- whether stores are exposed via React context + hook, a DI container, or
  a module singleton,
- the project's `enforceActions` setting (check the `configure(...)` call,
  usually in an app-entry or test-setup file) — it determines whether a
  mutation outside an action throws or only warns.

Match the existing convention; do not introduce a second store-wiring
style into a codebase that already has one.

### Step 2: Model the state

- Put state that the UI reads and that can change over time on
  `@observable` (or the appropriate variant — `.ref`/`.shallow`/`.struct`,
  see `rules/coding-style.mdc`) fields, not in a component's `useState`.
- Put anything derivable purely from other observable fields on a
  `@computed get` accessor instead of storing it separately and keeping
  it in sync by hand.
- Keep injected dependencies (services, sibling stores) as
  `private readonly` constructor parameters, not observable.

### Step 3: Write the actions

- Every method that mutates state gets `@action` (private orchestration)
  or `@action.bound` (public, UI-invoked). A public async action stays
  thin: guard check, then delegate to a `private async` method that does
  the real work (see `rules/patterns.mdc`'s async-action shape).
- Wrap every state mutation that happens after an `await` in
  `runInAction(() => { ... })`. Reach for `flow` instead only when a
  store has many sequential-await actions and the repeated
  `runInAction` blocks are genuinely the dominant noise in the file.
- Add an equality guard (`if (value !== current)`) before any mutation
  that could re-trigger a reaction feeding back into the same store from
  another store, per `rules/patterns.mdc`.

### Step 4: Wire reactions, if the store needs one

- Create `autorun`/`reaction`/`when` in the constructor or an `init()`,
  push the returned disposer into the store's `disposers` array, and call
  every disposer in `dispose()`.
- Prefer `reaction(() => selector, handler)` over `autorun` when the
  effect should respond to one specific value, not everything the
  handler body happens to read.
- Never start a raw `autorun`/`reaction` inside a component's render
  body; start it in `useEffect` (with cleanup) if it must live in the
  component rather than the store.

### Step 5: Wire the store into React

- Expose the store through a typed `createContext<XyzStore | null>(null)`
  and a `useXyzStore()` hook that throws if the context is unset — do not
  export a bare module-level store instance for components to import
  directly unless that already is the project's convention.
- Wrap every component that reads store state in `observer` from
  `mobx-react-lite`. If a component "doesn't re-render", check this
  first: a missing `observer` wrapper is the most common cause, followed
  by reading the observable value too early (destructured far from where
  it's rendered) breaking fine-grained tracking.

### Step 6: Verify

Run the project's type-check, lint, and store/component tests; see
Verification below for the exact bar.

## Rules

- Follow `rules/coding-style.mdc` for store shape, decorators, and
  observable-collection typing.
- Follow `rules/patterns.mdc` for the async-action shape, `flow`,
  reaction disposal, and the View↔Store boundary.
- ALWAYS wrap a post-`await` state mutation in `runInAction`; NEVER leave
  it as a bare assignment relying on `enforceActions` being off.
- ALWAYS wrap a component that reads observable state in `observer`;
  NEVER assume a plain function component will re-render on a store
  change just because it received the store as a prop.
- NEVER mutate observable state from inside a `@computed` getter.
- NEVER create a reaction (`autorun`/`reaction`/`when`) without storing
  and later calling its disposer.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just mutate `this.items` right after the `await`, it's simpler than wrapping it" | Outside an action, that mutation either throws under `enforceActions` or silently fails to notify observers depending on config — wrap it in `runInAction` |
| "This component isn't re-rendering, I'll add a `key` prop / force a remount" | A forced remount papers over the real cause; check for a missing `observer` wrapper or a value read too early first |
| "I'll skip the disposer, the store lives for the app's whole lifetime anyway" | Even a long-lived store's undisposed reactions keep running against stale data on route/user change; store and call the disposer |
| "I'll compute this inline in the component instead of a `@computed`, it's just one line" | A component-side recomputation runs on every render and drifts from the store's own reactivity graph the moment two components need the same derived value |

## Verification

Do not report the store/wiring done until all of the following hold:

- The project's type-check (e.g. `tsc --noEmit`) exits 0.
- Every action that mutates state after an `await` does so inside
  `runInAction` (or is a `flow` generator).
- Every component reading the new/changed observable state is wrapped in
  `observer`.
- Every `autorun`/`reaction`/`when` created has its disposer stored and
  called in `dispose()`.
- The project's lint (including `@typescript-eslint/explicit-member-accessibility`
  if configured) passes with no new suppressions.
- Existing store/component tests still pass; a new observable/action has
  at least one test exercising it (see `rules/testing.mdc`).
