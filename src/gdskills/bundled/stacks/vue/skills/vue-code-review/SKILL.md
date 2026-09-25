---
name: vue-code-review
description: "Use when reviewing changed Vue 3 Single File Component or composable code (.vue) for reactivity bugs -- lost reactivity from destructuring reactive()/props, missing watch cleanup, prop mutation instead of emit, v-for key misuse, v-html injection risk, and Pinia store boundary violations. Read-only, no repository convention-doc lookup and no MobX/React store review. Not for authoring or fixing the component (use vue-implementation or vue-build-fix)."
triggers:
  - "review this vue component diff for reactivity bugs"
  - "check this vue pull request for prop mutation"
  - "does this vue composable leak a watcher"
  - "review this pinia store change"
  - "check for v-html injection in this vue template"
  - "review this vue component's v-for keys"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Vue code review

Review changed Vue 3 Single File Component or composable code for
reactivity and structural bugs. Read-only: report findings, do not edit
the code under review. See `rules/patterns.mdc` for the reactivity/
composable rules a diff should follow and `rules/security.mdc` for
`v-html`/routing risks.

## Scope

- Reviews `.vue` files and the composables/Pinia stores a changed
  component pulls in.
- Not for the `<script>`-only TypeScript/Node.js parts of a project with
  no Vue rendering surface (use `nodejs-code-review`), and not for a
  React or MobX store diff.
- Does not read the repository's own convention docs -- flags what the
  diff itself shows against the rules below, not against local style
  guides.

## Workflow

### Step 1: Read the diff for reactivity boundary breaks

- Any place a `reactive()` object, a Pinia store's state, or (on
  pre-3.5 Vue) `defineProps()`'s return value is destructured into a
  loose local variable and later expected to stay live.
- Any `watch`/`watchEffect` created outside `setup`/`<script setup>`
  scope (inside a manually managed subscription, an event listener
  registered once at module scope) with no stored stop handle to clean
  it up.
- A `watch` whose source is broader than what actually changed (a whole
  reactive object with `{ deep: true }` when only one field matters).

### Step 2: Check prop/emit and component boundaries

- A prop mutated in place inside the component that receives it
  (`props.foo = ...`, `props.items.push(...)`) instead of emitting an
  event for the parent to act on.
- `defineProps`/`defineEmits` using the untyped runtime-object/string-
  array form where the surrounding file is otherwise TypeScript, losing
  compile-time checking on the component's own public contract.
- A `v-for` list with no `:key`, or `:key` bound to the array index on a
  list whose order or membership can change (reordering, filtering,
  insertion in the middle) -- index keys silently misattribute component
  state across re-orders.

### Step 3: Check security-relevant sinks

- `v-html` bound to anything that can carry user-controlled content with
  no sanitization step immediately before the binding.
- A dynamic `:href`/`:src` bound to user-controlled input with no
  scheme allowlist.
- A route param (`route.params.*`) used directly in a redirect target,
  query, or `v-html` value with no validation.

### Step 4: Check Pinia store boundaries

- An action in one store mutating another store's state directly
  instead of calling that store's own exported action.
- Store state read or mutated from outside any component/setup
  reactivity scope (e.g. a plain module-level side effect) in a way that
  will not trigger the expected reactive updates.

### Step 5: Report findings

For each finding: file:line, what the diff does, why it is a bug (which
rule it violates), and the concrete fix -- as a suggestion, not an edit
you apply yourself.

## Rules

- Follow `rules/patterns.mdc` for reactivity/composable/store boundary
  rules and `rules/security.mdc` for `v-html`/routing/store-persistence
  risks.
- Read-only: report findings and suggested fixes; do not edit the
  reviewed files.
- Do not flag a destructured `defineProps()` on a confirmed Vue 3.5+
  project as broken reactivity -- it is reactive there by design; check
  the `vue` dependency version before flagging this pattern.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The `v-for` has a `:key`, so the missing-key rule doesn't apply, even though it's `:key=\"index\"`" | An index key on a reorderable/filterable list still causes Vue to misattribute component state across items after a reorder; the rule is about a *stable* key, not merely the presence of one |
| "This destructured `const { count } = store` looks fine, JS objects are always live" | A plain destructure of Pinia/reactive state captures a snapshot value, not a live binding -- flag it unless `storeToRefs`/`toRefs` wraps it first |
| "The prop mutation is inside a `watch`, so it's not really 'the component' mutating it" | A `watch` handler runs as part of the component's own reactive scope; mutating `props.x` there is the same violation as doing it in a click handler |
| "`v-html` is bound to a value from our own API, so it's safe" | Content originating from an API is only as trustworthy as whatever produced it upstream (e.g. user-submitted text stored and echoed back); flag it unless a sanitize step sits immediately before the binding |

## Verification

Before finishing the review, confirm:

- Every reactivity-boundary finding names the exact line and the
  specific pattern violated (not a vague "check reactivity here").
- Every `v-for`/`v-html`/prop-mutation finding includes the concrete
  fix (the corrected `:key` expression, the sanitize call, or the emit
  to add), not just "this looks wrong".
- No suggested fix was applied to the files under review -- the skill
  only reports.
- The report distinguishes a genuine Vue 3.5+ destructured-props usage
  (fine) from a pre-3.5 or reactive()/store destructure (a real bug).
