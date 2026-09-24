---
name: react-code-review
description: "Use when reviewing changed React component or hook code (.tsx/.jsx) for Rules of Hooks violations, effect dependency bugs, stale closures, key misuse, in-place state mutation, re-render hot spots, accessibility gaps, and dangerouslySetInnerHTML/URL XSS sinks -- read-only, no MobX store review and no repository convention-doc lookup."
triggers:
  - "review this react component diff for hook and jsx bugs"
  - "check the react hooks in this pull request for rules of hooks violations"
  - "does this react useEffect have a dependency array bug"
  - "review this component for accessibility"
  - "any stale closure in this hook"
  - "check for xss in this jsx"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# React code review

Read-only review of changed `.tsx`/`.jsx` component/hook code against
React's own correctness and accessibility model. This skill never edits
code — it reports findings for a human or a follow-up fix skill
(`react-build-fix`) to act on.

**Scope boundary (read this before triggering):** this skill checks
React's rendering/hooks model itself — Rules of Hooks, effect
dependencies, closures, keys, mutation, re-renders, accessibility, and DOM
XSS sinks. It does NOT review MobX (or any other) state-management-library
usage (observers, actions, stores, reactions — that is a store-review
skill's job) and it does NOT check a repository's own local convention
docs (CLAUDE.md-style rules, i18n placement, styling tokens — that is a
convention-review skill's job). On a diff that touches both plain React
concerns and a state-management store, run this skill for the component
side and the appropriate store-review skill for the store side; see
`governance/scout.json` for why these stay separate skills instead of one
merged reviewer.

## Workflow

### Step 1: Scope the diff

1. Identify changed `.tsx`/`.jsx` files and, within them, changed hooks,
   effects, event handlers, and JSX return blocks — line-level, not the
   whole file, unless the whole file is new.
2. Note the React major and whether the React Compiler is enabled
   (changes whether manual memoization is a finding or a non-issue).
3. Skim 1 file of surrounding context per changed component to know its
   existing prop/state shape — a review without context misreads intent.

### Step 2: Check hooks correctness

- Rules of Hooks: any hook called conditionally, in a loop, after an early
  return, or inside a plain (non-hook, non-component) function — flag as a
  correctness bug, not a style note. Check this FIRST, before looking at
  dependency arrays or closures: scan every component/hook body top to
  bottom for a `return`/`if (...) return` sitting above a `useState`/
  `useEffect`/`useMemo`/`useCallback`/other hook call, since a hook that
  runs conditionally on some renders and not others breaks React's
  per-render hook ordering. For example:
  ```jsx
  function UserPanel({ id }) {
    if (!id) return null;              // <- runs before the hooks below
    const [user, setUser] = useState(null);   // <- Rules of Hooks violation
    useEffect(() => { fetchUser(id).then(setUser); }, [id]);
    return <div>{user?.name}</div>;
  }
  ```
  is a Rules of Hooks violation: on a render where `id` is falsy, `useState`
  and `useEffect` are skipped entirely, and on the next render where `id`
  is truthy they run — a different hook count/order between renders. The
  fix is to move the early return below all hook calls (call every hook
  unconditionally, then branch in the returned JSX or inside the hook's own
  callback). Flag this before ever discussing the effect's dependency
  array — a dependency-array note here would bury the actual bug.
- Effect dependency arrays: every reactive value read inside the effect
  body appears in the dependency array, or the omission is deliberate and
  safe (a ref, a setState function) — a missing dependency that reads a
  prop/state value is a real staleness bug, not a lint nag to suppress.
- Stale closures: a callback (event handler, effect body, timer callback)
  that captures a prop/state value from an earlier render and is not
  re-created when that value changes — look especially at
  `useCallback`/`useMemo` dependency arrays and any handler stored in a
  ref for later use.
- An effect whose only job is to call `setState` from a prop/state change
  it could instead derive during render — flag per `rules/patterns.mdc`
  ("Derive, don't sync"), since it usually signals a design bug, not a
  missing dependency.

### Step 3: Check rendering correctness

- List `key`s: array index used as `key` on a list that can reorder,
  filter, or have items inserted/removed — flag as a bug (broken local
  state/focus/animation across reorders), not a style nit.
- Mutation: props, state, or a value derived from either mutated in place
  (`.push`, `.sort`, direct property assignment) instead of replaced —
  React relies on referential identity to detect changes.
- Re-render hot spots: a new object/array/function literal created inline
  in a hot render path and passed to a memoized child, defeating the
  memoization; an expensive computation run on every render with no
  memoization and no compiler to catch it.

### Step 4: Check accessibility and security

- Semantic elements over generic `div`/`span` with a click handler
  (`<button>` for actions, proper heading levels, form labels associated
  via `htmlFor`/`id` or wrapping).
- Focus management: a modal/dialog that traps and restores focus, a route
  change that resets focus/announces to assistive tech where the project
  already has a pattern for it.
- `dangerouslySetInnerHTML` with unsanitized input, a `javascript:`-scheme
  URL reaching `href`/`src` from user data, or a secret read through a
  public-env-prefixed variable inside client code — all per
  `rules/security.mdc`.

### Step 5: Report

Findings only, grouped by severity, each with file:line, the concrete bug
(not a style preference), and the fix direction — never a code edit:

```
CRITICAL: src/components/UserList.tsx:42 — array index used as key on a
  filterable list; local input state will attach to the wrong row after a
  filter change. Use item.id as the key.
HIGH: src/hooks/useUserSearch.ts:18 — effect reads `query` but the
  dependency array is `[]`; search will silently use the first-render
  query forever.
```

## Rules

- NEVER edit code — findings only.
- NEVER report a plain style preference (naming, formatting) as a
  correctness finding; route that to a style/convention reviewer instead.
- NEVER flag MobX observer/action/store patterns — out of scope for this
  skill (see Scope boundary above).
- ALWAYS give a concrete fix direction, not just "this looks wrong."

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This effect's missing dependency is probably intentional, I'll skip it" | A missing dependency on a value the effect body actually reads is a staleness bug more often than an intentional omission; call it out and let the author confirm intent explicitly |
| "The store looks off too, I'll flag the MobX action pattern while I'm here" | Out of scope for this skill by design — flag the React-side finding and note the store needs its own store-review pass, do not blur the two |
| "Index-as-key is common, I won't flag it unless the list is huge" | The bug (broken identity across reorders) does not depend on list size; flag it whenever the list can reorder, filter, or splice regardless of length |
| "I'll just fix the dependency array myself since it's a one-line change" | This skill is read-only; even a one-line fix belongs to a fix skill or the author, reported as a finding, not applied |

## Verification

Before reporting, confirm:

- Every finding cites a specific file:line and a concrete bug, not a
  vague concern.
- No finding is actually a MobX/store-pattern issue or a repository
  convention-doc issue (those belong to other review skills).
- Rules of Hooks and effect-dependency findings were checked against the
  actual reactive values read in each effect/callback body, not assumed
  from the dependency array alone.
- Accessibility and security findings reference `rules/security.mdc` or a
  concrete WCAG-relevant gap (missing label, wrong semantic element),
  not a generic "consider accessibility" note.
