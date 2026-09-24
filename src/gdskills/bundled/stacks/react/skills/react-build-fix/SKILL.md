---
name: react-build-fix
description: "Use when a React component fails to type-check, lint, or build -- JSX/TSX prop and children typing errors, event handler and ref types after the React 19 types changes, eslint-plugin-react-hooks failures, and Vite/webpack/Next.js bundler build failures or hydration mismatches. Fixes the root cause, never disables the hooks lint rule or casts to any."
triggers:
  - "fix this tsx type error"
  - "react-hooks lint is failing"
  - "vite build is failing on this component"
  - "hydration mismatch error"
  - "ref type error after upgrading react types"
  - "children prop type error"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# React build fix

Fix a failing type-check, lint, or bundler build caused by React component
code. Scoped to failures that originate in `.tsx`/`.jsx` component code or
its JSX/hooks typing — a failure with no React-specific cause (a plain
module import error, a Node config issue) is `ts-js-node`'s build-fix
skill, not this one.

## Workflow

### Step 1: Reproduce and classify

Run, in order, until one fails (use `agentProfile.buildCommands` from
`pack.json` as the starting point, adjusted to the project's actual
scripts):

1. Type-check (`tsc --noEmit` or the project's script).
2. Lint, with `eslint-plugin-react-hooks` enabled.
3. Test run.
4. Bundler build (Vite/webpack/Next.js).

Read the first failure's full message — do not guess from the file name.
Classify it as: JSX/TSX typing (props, children, events, refs), hooks-lint
(`react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`), or bundler/
hydration.

### Step 2: Fix JSX/TSX typing errors

- Props typing error: fix the `interface`/`type` to match how the
  component is actually used, or fix the call site — do not widen the
  prop type to `any`/`unknown` to make the error disappear.
- Children typing: type `children` explicitly (`React.ReactNode` for
  arbitrary children, a narrower type when only specific children are
  valid) rather than accepting `any`.
- Event handler typing: use the specific React event type for the element
  and event (`React.ChangeEvent<HTMLInputElement>`,
  `React.MouseEvent<HTMLButtonElement>`), not a hand-rolled loose type.
- Ref typing after the React 19 types change (`ref` as an ordinary prop
  on function components): type it as
  `React.Ref<ElementType>`/`React.RefObject<ElementType>` matching what
  the component actually forwards; if the project is still on
  `forwardRef`, match `forwardRef`'s own generic signature instead of
  mixing the two patterns in one component.

### Step 3: Fix hooks-lint errors

- `rules-of-hooks` violation: restructure so the hook call is
  unconditional and top-level — move the condition inside the hook's own
  logic, or split into two components/hooks. Never add an
  `eslint-disable-next-line react-hooks/rules-of-hooks` comment.
- `exhaustive-deps` violation: add the missing reactive dependency, or, if
  the value is intentionally stable (a ref, a dispatch function, a value
  the author has confirmed never needs to trigger the effect), use the
  lint rule's own escape hatch documented for that case rather than a
  blanket disable comment — and only after confirming the value truly
  cannot change in a way the effect needs to react to.

### Step 4: Fix bundler and hydration failures

- Bundler build failure: read the actual bundler error (missing export,
  bad dynamic import, unsupported syntax for the configured target) and
  fix the source or import, not the bundler config, unless the config
  itself is provably wrong for the project's stated target.
- Hydration mismatch: find what differs between server and client render
  — a `Date`/`Math.random`/`typeof window` branch evaluated during render,
  locale/timezone-dependent formatting, or state initialized differently
  on each side. Fix by making the server and first client render produce
  identical output (move the divergent value into an effect that runs
  post-hydration, or pass it down as a prop already resolved server-side)
  — do not silence the warning by wrapping the whole tree in a
  client-only guard unless the divergent content is genuinely
  client-only.

### Step 5: Verify and report

```bash
keryx test run --changed --strict
```

Re-run the exact command that failed in Step 1 and confirm it now exits 0,
then re-run the full chain (type-check, lint, test, build) once to confirm
the fix did not break an earlier step.

```
Fixed: src/components/UserCard.tsx:18 — onSave typed as
  React.MouseEvent<HTMLButtonElement> to match the actual click handler
  signature; tsc --noEmit now passes.
```

## Rules

- ALWAYS fix the root cause with the smallest change that resolves it.
- NEVER disable or downgrade `eslint-plugin-react-hooks` rules to make a
  lint failure disappear.
- NEVER cast a prop, ref, or event to `any`/`as any` to silence a type
  error.
- NEVER delete or loosen a failing test assertion to make a build/test
  step pass.
- Stop after 3 fix iterations on the same failure and report what remains,
  rather than escalating to a disable/cast/deletion.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add eslint-disable-next-line to get lint green" | Silences a rule designed to catch a real class of runtime bug (stale closures, hook-order crashes); fix the dependency or hook placement instead |
| "This type error is annoying, I'll cast to any" | Removes the type check entirely at that point, including for the next person's edit; fix the actual type mismatch |
| "The hydration warning is harmless, I'll wrap everything in a client-only check" | Over-broad client-only guards flash empty/loading content for content that could have rendered on the server; find the actual server/client divergence first |
| "Test's failing after my fix, I'll just skip it" | Skipping hides a real regression the build-fix may have introduced; investigate before moving on |

## Verification

Do not report the work done until all of the following hold:

- The exact command that failed in Step 1 now exits 0.
- The full chain (type-check, lint, test, build) still passes after the
  fix — a fix to one step did not regress an earlier one.
- No `eslint-disable` comment was added for a hooks rule, and no `as any`/
  `: any` was added to route around a type error.
- `git status` shows only the files whose failure was being fixed (plus
  their types, if the fix was a type definition change).
