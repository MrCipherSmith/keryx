---
name: vue-implementation
description: "Use when building or changing a Vue 3 Single File Component, composable, or Pinia store -- covers <script setup> with type-based defineProps/defineEmits, choosing ref vs reactive, computed vs watch/watchEffect, composable extraction, and Pinia store/action design. Not for Options API legacy components (use vue2-to-vue3-migration) or Node.js service/CLI code with no .vue file (use nodejs-implementation)."
triggers:
  - "build a vue component"
  - "add a composable to this vue app"
  - "wire up a pinia store"
  - "add props and emits to this vue component"
  - "should this be ref or reactive"
  - "implement this vue form with v-model"
  - "extract this logic into a use composable"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Vue implementation (Composition API)

Build or change a Vue 3 Single File Component, composable, or Pinia store
using the Composition API. See `rules/coding-style.mdc` for `<script
setup>` typing conventions, `rules/patterns.mdc` for reactivity and
composable design, and `rules/security.mdc` for `v-html`/routing risks a
new component must avoid.

## Workflow

### Step 1: Discover the project's own conventions

Before writing anything, check:

- Does the project use `<script setup lang="ts">` everywhere, or does it
  still have Options API components? Match the file's neighbors in the
  same directory, not a mix.
- Is state management Pinia, Vuex, or ad hoc `provide`/`inject` +
  composables? Check `package.json` and an existing store file.
- Is the project on Vue 3.5+ (destructured `defineProps()` stays
  reactive) or an earlier 3.x (destructuring breaks reactivity)? Check
  `package.json`'s `vue` dependency version before choosing which prop
  access style to write.
- Is `eslint-plugin-vue` configured, and with which rule preset
  (`recommended`, `strongly-recommended`)? Its rule set decides template
  formatting details (self-closing tags, attribute order) worth matching.

### Step 2: Design the component/composable boundary

- A piece of state or behavior used by more than one component becomes a
  composable (`useX()`), not copy-pasted `ref`/`watch` blocks.
- State shared across unrelated branches of the component tree (not just
  parent-to-child) is a Pinia store, not `provide`/`inject` bolted onto an
  unrelated ancestor.
- A component that only renders based on props and emits events, with no
  store/composable dependency of its own, stays "dumb" -- push data
  fetching and derived state up into a parent or a composable it calls.

### Step 3: Declare props, emits, and reactive state

- Type-only `defineProps<{ ... }>()` / `defineEmits<{ ... }>()`, not the
  runtime-object form -- see `rules/coding-style.mdc`.
- Choose `ref()` for a value reassigned wholesale, `reactive()` for a
  fixed-shape object mutated in place -- see `rules/patterns.mdc`. Never
  destructure a `reactive()` object or a pre-3.5 props object into loose
  variables; that breaks the reactive link.
- Choose `computed()` for a pure re-derivation, `watch`/`watchEffect`
  only for an actual side effect (fetch, DOM measurement, external sync).

### Step 4: Wire the store (when the feature needs one)

- Define Pinia state, getters, and actions in `defineStore()`; keep
  mutation inside the store's own actions -- a component calls an action,
  it does not reach in and mutate `store.someField` directly from outside.
- One store owns one another store's state through that store's own
  actions, not by importing and mutating it directly.

### Step 5: Verify

Run the project's own scripts (they may wrap these with extra flags):

```bash
npx vue-tsc --noEmit
npx eslint .
npm test
```

Confirm the new component renders without a runtime prop-mutation warning
and that events fire with the expected payload (check in a quick manual
mount or the existing dev server) before calling the feature done.

## Rules

- Follow `rules/coding-style.mdc` for `<script setup>`/prop/emit typing.
- Follow `rules/patterns.mdc` for `ref`/`reactive` choice, composable
  extraction, and `provide`/`inject` vs. Pinia store decisions.
- Follow `rules/security.mdc` before adding any `v-html` binding or a
  dynamic `:href`/`:src` from user-controlled input.
- NEVER mutate a prop in place inside the child; emit an event
  (`emit('update:modelValue', v)`) and let the parent own the state.
- NEVER destructure a `reactive()` object into loose variables expecting
  them to stay reactive.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just mutate `props.items.push(...)` directly, it's simpler than emitting" | Vue warns at runtime; the parent's data silently drifts from what it thinks it owns, and the mutation is invisible to anyone reading the parent |
| "I'll destructure `const { count } = state` from this `reactive()` object for convenience" | `count` is now a frozen copy at destructure time; later mutations to `state.count` never update it, producing a component that silently stops re-rendering |
| "I'll skip the composable and just copy this fetch+loading+error block into the second component" | Two independent copies of the same stateful logic drift apart the next time either one is bugfixed |
| "`watch(props, ...)` with `deep: true` is easier than picking the one field I actually need" | A whole-object deep watch fires on every unrelated field change and is expensive on any non-trivial object |

## Verification

Do not report the feature done until all of the following hold:

- `vue-tsc --noEmit` (or the project's own type-check script) exits 0.
- `eslint .` exits 0 with no new `eslint-disable` added.
- No prop is mutated in place; every parent-visible change goes through
  an emitted event or a store action.
- Every `defineProps`/`defineEmits` is the type-only form, not the
  runtime-object form, unless the surrounding file is still Options API.
- `git status` shows changes confined to the files the feature required.
