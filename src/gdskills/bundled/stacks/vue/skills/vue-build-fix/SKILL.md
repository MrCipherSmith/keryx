---
name: vue-build-fix
description: "Use when resolving a vue-tsc template type error, an eslint-plugin-vue lint failure, or a Vite build error in a Vue 3 project -- covers template expression type mismatches, defineProps/defineEmits type errors, unresolved SFC/component imports, and Vite plugin/HMR build failures. Applies the smallest root-cause fix and never silences the checker with an any cast or an eslint-disable. Not for a generic tsc error in a .ts file with no .vue involved (use nodejs-build-fix) or a JSX/React build failure (use react-build-fix)."
triggers:
  - "fix this vue-tsc template type error"
  - "vite build is failing on this vue component"
  - "eslint-plugin-vue is failing on this component"
  - "defineProps type error in this vue component"
  - "cannot find module for this .vue import"
  - "this vue component's template type check is failing"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Vue build-fix (vue-tsc / eslint-plugin-vue / Vite)

Resolve a `vue-tsc` template type error, an `eslint-plugin-vue` lint
failure, or a Vite build failure blocking a Vue 3 build. Applies the
smallest change that fixes the actual root cause. See
`rules/coding-style.mdc` for the prop/emit typing conventions a correct
fix should restore.

## Workflow

### Step 1: Reproduce the failure

```bash
npx vue-tsc --noEmit
npx eslint .
npx vite build
```

Run the project's own `package.json` scripts if they wrap these with
extra flags (path aliases, multiple tsconfig projects). Capture the
exact error, including the `.vue` file, line, and (for a template error)
whether it points inside `<template>` or `<script setup>`.

### Step 2: Classify the failure

- **Template type error**: `vue-tsc` reports a type mismatch inside
  `<template>` -- a prop/expression type that does not match what the
  template does with it (e.g. calling `.toFixed()` on a value typed
  `string | number`), or a bound event handler with the wrong signature.
- **`defineProps`/`defineEmits` type error**: the type-only declaration
  itself does not compile (an invalid generic, a prop default that does
  not satisfy `withDefaults`' inferred type).
- **Import/resolution error**: `Cannot find module '...vue'`, an
  unresolved `@/` alias, or a component registered but never imported.
- **Lint error**: an `eslint-plugin-vue` rule violation -- read the rule
  name, not just the message.
- **Vite build error**: a plugin failure, an asset that cannot be
  resolved, or an HMR-only issue that does not reproduce in `vite build`.

### Step 3: Find the root cause

**Template type errors**: trace the expression's value back to its
`ref`/`computed`/prop declaration; a union type reaching the template
usually means the narrowing needs to happen before the template (a
computed that narrows, or an inline type cast per Vue's documented
`(x as T)` pattern only when the narrowing is genuinely safe at that
point) -- not a broadened type on the source declaration that hides a
real case the template does not otherwise handle.

**`defineProps`/`defineEmits` errors**: check the interface/type literal
passed to the generic; a `withDefaults` default that does not structurally
satisfy the prop's declared type is usually the type declaration being
wrong about optionality, not a checker bug.

**Import/resolution errors**: check `vite.config.ts`'s `resolve.alias`
matches `tsconfig.json`'s `paths`, and that the `.vue` extension is
covered by `moduleFileExtensions`/`vueCompilerOptions` where the runner
needs it explicitly (Vitest, not Vite itself, which resolves `.vue`
via its Vue plugin).

**Lint errors**: read what the specific `eslint-plugin-vue` rule
enforces (e.g. `vue/no-mutating-props` wants an emit instead of a prop
write, not a suppression) before changing the code to satisfy it.

### Step 4: Apply the smallest correct fix

- A template type error: narrow the value correctly (a `computed()` that
  returns the narrowed type, or a scoped inline cast at the point the
  narrowing is actually safe) -- not a broadened prop/ref type that
  silently accepts a case the template cannot actually handle.
- A `defineProps`/`defineEmits` error: correct the type literal or the
  `withDefaults` default so it genuinely matches -- not a cast to `any`
  on the destructured value.
- An import/resolution error: fix the alias/extension config that
  genuinely matches the project's build target -- not a blanket
  `skipLibCheck`/`moduleResolution` change that papers over the real
  mismatch.
- A lint error: change the code to satisfy the rule's actual intent
  (e.g. replace a direct prop mutation with an emit for
  `vue/no-mutating-props`).

### Step 5: Verify and report

Re-run the exact command from Step 1; confirm it exits 0. Report the
root cause and the fix, not just "error resolved".

## Rules

- Follow `rules/coding-style.mdc` for the prop/emit typing conventions a
  fix should restore, not just silence.
- ALWAYS fix the root cause with the smallest change; never widen the
  fix beyond the file(s) the failure actually touches.
- NEVER use `@ts-ignore`, a cast to `any`, or an `eslint-disable` comment
  on a `.vue` file's `<script>` or template expression to make an error
  disappear.
- NEVER mutate a prop in place as a "quick fix" for a `vue/no-mutating-
  props` lint failure -- add the emit the rule is asking for.
- NEVER delete or skip a failing test to turn the build green.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll cast this template expression `(x as any).toFixed(2)` to unblock vue-tsc" | Erases the type entirely at that call site; the union the checker flagged usually needs an actual narrowing branch, not a blanket escape hatch |
| "eslint-disable this `vue/no-mutating-props` line, the mutation is harmless here" | The rule exists because a prop mutation is invisible to the parent and Vue warns about it at runtime too; add the emit the rule is asking for instead of suppressing it |
| "I'll widen the prop's type to `any` so `defineProps` stops complaining" | Removes type checking from every consumer of that prop, not just this one call site |
| "This `.vue` import fails to resolve, I'll just add `skipLibCheck: true` and move on" | `skipLibCheck` skips checking `.d.ts` files, it does not fix a genuinely broken alias or missing extension resolution -- the import still fails at runtime |

## Verification

Do not report the fix done until all of the following hold:

- The exact command that reproduced the failure in Step 1 now exits 0.
- No `@ts-ignore`, `any` cast, or `eslint-disable` was added to the
  `.vue` file.
- No unrelated `tsconfig.json`/`vite.config.ts`/`eslint` config was
  loosened.
- A `vue/no-mutating-props` fix added an emit, not a suppression.
- The report states the actual root cause, not just "fixed the error".
