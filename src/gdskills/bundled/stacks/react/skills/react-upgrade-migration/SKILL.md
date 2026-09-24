---
name: react-upgrade-migration
description: "Use when upgrading a codebase across React major versions (e.g. 18 to 19) -- removing legacy APIs (string refs, legacy context, propTypes/defaultProps on function components, ReactDOM.render/hydrate), applying official codemods, updating the @types/react package, fixing the act import, and staging the rollout."
triggers:
  - "upgrade this project to react 19"
  - "migrate off ReactDOM.render"
  - "remove string refs"
  - "fix propTypes deprecation warning"
  - "run the react codemod"
  - "update @types/react for the new major"
metadata:
  origin: authored
  category: migrate
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# React upgrade / migration

Move a codebase from one React major to a newer one (most commonly 18 to
19), removing APIs the new major dropped and adopting its replacements.
Scoped to the React library/types/runtime upgrade itself — a related
bundler or framework major upgrade (Next.js, Vite) that happens alongside
it is out of scope unless the failure is caused by a React API removal.

## Workflow

### Step 1: Establish the starting point and target

1. Read the current `react`/`react-dom`/`@types/react`/`@types/react-dom`
   versions from `package.json` and the target major from the user's
   request.
2. Read the official React upgrade guide for that version range (the
   project's own `CHANGELOG`/release notes if vendored, otherwise the
   canonical upgrade guide) before touching code — do not rely on memory
   of a prior major's migration for a different jump.
3. Inventory usage of the APIs the target major removes or changes (grep
   the codebase; see Step 2 per-API list) so the scope of the change is
   known before starting, not discovered file-by-file.

### Step 2: Remove/replace legacy APIs (18 -> 19 checklist)

- **String refs** (`ref="myRef"`): replace with `useRef`/`createRef` (or
  the React 19 ref-as-prop pattern for a component receiving a ref from
  its parent). String refs are removed, not deprecated-but-working.
- **Legacy context** (`contextTypes`/`getChildContext`): replace with
  `createContext`/`useContext`. Legacy context is removed.
- **`propTypes`/`defaultProps` on function components**: `propTypes` no
  longer has any effect at runtime in React 19+; if the project relies on
  it for runtime validation, replace the validation with TypeScript types
  (preferred, if the project is TS) or an explicit runtime check. Replace
  `defaultProps` with a default parameter value in the function signature
  (`function C({ x = 1 }: Props)`), since function-component
  `defaultProps` is removed.
- **`ReactDOM.render`/`ReactDOM.hydrate`**: replace with
  `createRoot(container).render(...)` and `hydrateRoot(container,
  ...)` respectively from `react-dom/client`. Update the app's entry
  point; this is usually a single-file change but touches every test
  helper that also bootstraps a root.
- **`react-dom/test-utils`' `act`**: import `act` from `react` (or
  `react-dom/test-utils`'s deprecated re-export, if the project pins an
  older React Testing Library that still expects it) — check the
  project's RTL version compatibility before changing the import broadly.
- **Any other removed API the upgrade guide lists for this specific
  version jump** (e.g. `ReactDOM.unmountComponentAtNode`,
  `ReactDOM.findDOMNode` deprecation) — do not assume the 18->19 list
  above is exhaustive for a different version range.

### Step 3: Apply codemods, then hand-fix the rest

1. Run the official `react-codemod`/`types-react-codemod` transforms
   applicable to the identified APIs (e.g. the ref-as-prop and
   `StrictMode`-related codemods) rather than hand-editing every call
   site — codemods cover the mechanical rewrite; review their diff before
   committing.
2. Hand-fix what the codemod cannot express (usually the `propTypes` ->
   TypeScript-type conversion and any app-specific wrapper around
   `ReactDOM.render`).
3. Update `@types/react`/`@types/react-dom` to the versions matching the
   new React major; a mismatched types package produces type errors
   unrelated to the actual runtime migration — resolve that first before
   chasing other type errors.

### Step 4: Stage the rollout

- For a large codebase, migrate in slices (by directory/feature) with each
  slice green (type-check, lint, test, build) before moving to the next,
  rather than one large flip that leaves the tree red for an extended
  period.
- Keep the previous major's peer dependencies (libraries pinned to the old
  React major) identified before starting — a library incompatible with
  the new major blocks the upgrade at that dependency, not in app code;
  surface this as a blocker rather than working around it with a version
  override that silences a real incompatibility.

### Step 5: Verify and report

```bash
keryx test run --changed --strict
```

Then the full chain: type-check, lint (with `react-hooks` plugin), test,
build — per `agentProfile.buildCommands`.

```
Migrated: react 18.3 -> 19.0
  - ReactDOM.render -> createRoot in src/main.tsx
  - removed propTypes from 4 components, added TS prop types
  - ran react19-ref-as-prop codemod across src/components (12 files)
  - @types/react bumped to ^19.0.0
  - full build chain green
```

## Rules

- ALWAYS read the target version's own upgrade guide before starting —
  do not assume a prior migration's checklist applies unchanged to a
  different version jump.
- ALWAYS run an official codemod for a mechanical rewrite it covers before
  hand-editing the same pattern across many files.
- NEVER leave a mix of the old and new API for the same concern in the
  same file (e.g. `ReactDOM.render` in one entry point,
  `createRoot` in another) without flagging it as an inconsistency.
- NEVER silence a genuine peer-dependency incompatibility with a version
  override/resolution — report it as a blocker.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I remember how the last major migration went, I'll skip re-reading the guide" | Removed/changed APIs differ per version jump; acting on a stale mental model misses this version's actual list |
| "I'll hand-edit all 40 call sites instead of running the codemod" | Slower and more error-prone than the maintained codemod for a mechanical rewrite; run the codemod, then hand-fix only what it cannot express |
| "This library isn't compatible with the new major yet, I'll force the version with a resolution override" | Hides a real incompatibility that will surface as a runtime bug instead of a clear install-time blocker; report it and let the author decide (wait, replace the library, or patch) |
| "I'll migrate everything in one big commit, staging slices takes too long" | A single large flip leaves no bisectable, independently-verifiable checkpoint if something breaks partway through a large codebase |

## Verification

Do not report the work done until all of the following hold:

- Every API on this skill's removed-API checklist that the inventory
  (Step 1) found is either migrated or explicitly listed as out of scope
  with a reason.
- No file mixes the old and new form of the same migrated API.
- `@types/react`/`@types/react-dom` versions match the target React major.
- The full build chain (type-check, lint, test, build) is green after the
  migration.
- `git status`/the diff reflects only the migration's intended scope —
  no unrelated refactor bundled in.
