---
name: vue2-to-vue3-migration
description: "Use when migrating a Vue 2 (Options API) codebase or component to Vue 3 -- covers converting Options API to <script setup> Composition API, replacing the removed filters and $listeners/$children APIs, Vuex-to-Pinia store migration, v-model breaking changes (single default to multiple named bindings), global API changes (createApp vs new Vue), and Vue 2 lifecycle hook renames (beforeDestroy -> beforeUnmount). Not for a fresh Vue 3 component with no legacy code (use vue-implementation)."
triggers:
  - "migrate this vue 2 component to vue 3"
  - "convert this options api component to composition api"
  - "upgrade this app from vue 2 to vue 3"
  - "migrate this vuex store to pinia"
  - "fix this v-model breaking change after upgrading to vue 3"
  - "replace this vue 2 filter with vue 3"
metadata:
  origin: authored
  category: migrate
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Vue 2 -> Vue 3 migration

Migrate a Vue 2 (Options API) component, store, or app to Vue 3. See
`rules/coding-style.mdc` and `rules/patterns.mdc` for the Composition API
conventions the migrated code should land in, not the Options API shape
it started from.

## Workflow

### Step 1: Inventory what actually changed for this codebase

Do not attempt a blind global rewrite. Identify which of these the
project actually uses before touching anything:

- Options API components (`data()`, `methods`, `computed`, `watch`,
  lifecycle hooks as object keys) to convert to `<script setup>`.
- Vue 2 filters (`{{ value | currency }}`) -- removed entirely in Vue 3;
  replace with a computed property or a plain method call.
- `this.$listeners` -- removed; Vue 3 merges listeners into `$attrs`
  automatically (`v-bind="$attrs"` now forwards both).
- `this.$children` -- removed; use a template ref or provide/inject
  instead of reaching into child instances.
- Global API: `new Vue({ ... })` / `Vue.use(plugin)` -> `createApp(App)`
  / `app.use(plugin)`; a global mixin/directive registration moves from
  `Vue.mixin`/`Vue.directive` to `app.mixin`/`app.directive`.
- Vuex store usage -- migrate to Pinia (the current recommended store)
  unless the project has an explicit reason to keep Vuex.

### Step 2: Convert one component at a time

- Move `data()` return values to individual `ref()`/`reactive()`
  declarations at the top of `<script setup>`.
- Move `computed` properties to `computed(() => ...)` calls.
- Move `methods` to plain functions in `<script setup>` scope --
  no `this` binding needed or available.
- Move `watch` entries to `watch()`/`watchEffect()` calls; a Vue 2
  `watch: { foo(newVal, oldVal) { ... } }` becomes `watch(() =>
  someSource, (newVal, oldVal) => { ... })` with an explicit source.
- Rename lifecycle hooks per the Vue 3 mapping: `beforeDestroy` ->
  `beforeUnmount`, `destroyed` -> `unmounted`; `created`/`beforeCreate`
  have no Composition API equivalent -- that code just runs inline in
  `<script setup>`'s top level, since setup itself runs at that point in
  the lifecycle.
- Convert `props`/`$emit` declarations to `defineProps<T>()`/
  `defineEmits<T>()` per `rules/coding-style.mdc`.

### Step 3: Handle the `v-model` breaking change

- Vue 2's single default `v-model` (`value` prop + `input` event) became
  Vue 3's `modelValue` prop + `update:modelValue` event by default, and
  Vue 3 supports multiple named `v-model:propName` bindings on one
  component. A component using the old `model: { prop: 'value', event:
  'input' }` option needs its prop/emit renamed (or an explicit
  `v-model:value` at every call site) -- pick one and apply it
  consistently, do not leave some call sites on the old contract.

### Step 4: Migrate Vuex state to Pinia (when applicable)

- A Vuex module's `state` becomes a Pinia store's `state` (or individual
  `ref`s in a setup-style store); `getters` become Pinia `getters` (or
  `computed`s); `mutations` + `actions` collapse into Pinia `actions`
  (Pinia has no separate mutations layer -- an action can assign state
  directly).
- Replace `this.$store.state.x` / `mapState`/`mapGetters`/`mapActions`
  usage in components with the equivalent Pinia store instance and,
  where destructuring is needed, `storeToRefs()`.

### Step 5: Verify

```bash
npx vue-tsc --noEmit
npx eslint .
npm test
npx vite build
```

Migrate and verify one component/store at a time rather than converting
the whole tree before running anything -- a broad simultaneous rewrite
makes the first failure much harder to localize.

## Rules

- Follow `rules/coding-style.mdc` and `rules/patterns.mdc` for the
  Composition API shape the migrated code lands in.
- NEVER leave a component half-migrated with both Options API keys and
  `<script setup>` code mixed in the same file -- Vue does not support
  that combination cleanly and it is confusing to read.
- NEVER silently drop a Vue 2 filter's behavior; convert it to a
  computed or method call with the same transformation applied, not just
  remove the filter usage.
- NEVER migrate a Vuex module's state shape into Pinia without checking
  every component that reads it through `mapState`/`mapGetters` --
  those call sites need updating too, not just the store definition.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll rewrite the whole app's components in one pass, then run the build once at the end" | The first failure is now ambiguous across dozens of changed files; migrate and verify one component/store at a time instead |
| "This filter isn't that important, I'll just drop it during the conversion" | Silently changes what the template renders; convert it to a computed/method with the same transformation, don't remove the behavior |
| "I'll leave `mapState`/`mapGetters` calling into the old Vuex store and only migrate the store definition to Pinia" | The store and its call sites have to move together; a component still importing Vuex helpers against a Pinia-shaped store fails immediately |
| "I'll mix Options API `methods` and `<script setup>` in the same file to save time on this one" | Vue does not support combining them cleanly in one SFC; finish the conversion instead of leaving it half done |

## Verification

Do not report a component/store migrated until all of the following hold:

- `vue-tsc --noEmit`, `eslint .`, and the project's test suite all exit
  0 for the migrated file(s).
- No file mixes Options API keys with `<script setup>` syntax.
- Every `v-model` call site for a migrated component uses the new
  `modelValue`/`update:modelValue` (or explicitly named) contract
  consistently.
- Every removed Vue 2 filter has an equivalent computed/method in the
  migrated component producing the same output.
- `git status` shows changes confined to the component(s)/store(s)
  actually being migrated in this pass.
