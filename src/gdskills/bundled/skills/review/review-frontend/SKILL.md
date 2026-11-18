---
name: review-frontend
model_tier: standard
description: "Use when a frontend review is requested, checking React component patterns, MobX state management (observer, actions, computed, reactions, lifecycle), View-Store boundaries, and TypeScript safety in changed frontend code. NOT for backend patterns, security vulnerabilities, performance bottlenecks, or cross-layer architecture."
triggers: ["frontend review", "component review", "ui review", "review React", "review components"]
metadata:
  author: "MrCipherSmith"
  version: "1.5.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
  stack_requires: "react,mobx"
  overlap_group: "frontend"
license: "MIT"
---

# Review: Frontend (React + MobX + TypeScript)

## Purpose

Validates frontend-specific patterns in the changed code of the current branch. Covers React component correctness (observer wrapping, MVVM boundary, useEffect misuse, accessibility basics, key props), full MobX store patterns (structure, member ordering, accessibility modifiers, observable collections, reactions, async actions, bidirectional sync, lifecycle, API placement), and TypeScript safety. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs. It runs no command unless its payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where its host gives a read-only child git (keryx shell does not: there the payload supplies the history).

This skill consolidates what two earlier profiles (a style one and a MobX store one, both removed) used to split between them, so it is the one reviewer for frontend style, MobX and store changes.

---

## Input Contract

| Field | Required | Description |
|-------|----------|-------------|
| Branch / diff range | No | Defaults to merge-base..HEAD + uncommitted changes |
| Explicit commit hash/range | No | Review only that range when provided |
| `JOB_NAME` | No | Job name when dispatched by orchestrator |
| `CONTEXT_PATH` | No | Path to context doc when dispatched by orchestrator |

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| React component patterns (observer, MVVM, useEffect, keys, a11y) | YES | — |
| MobX store: structure, actions, computed, reactions, lifecycle | YES | — |
| MobX: observable collections, bidirectional sync, disposers | YES | — |
| View↔Store boundary violations | YES | — |
| TypeScript safety in frontend code (no any, I* prefix, ?./??/!) | YES | — |
| Backend patterns, NestJS, server-side logic | NO | `review-logic`, `review-architecture` |
| Cross-layer architecture (service layer design, module boundaries) | NO | `review-architecture` |
| Security vulnerabilities (XSS, injection, auth gaps) | NO | `review-security-code` |
| Performance bottlenecks (N+1, bundle size, re-render frequency) | NO | `review-performance` |
| Code style, naming outside frontend conventions | NO | `review-style` |

---

## Iron Laws

### Shared laws (every reviewer)

Read the review activity rule before the code: `.metaproject/rules/project/activity/review.mdc` when the project keeps its own, else `.metaproject/rules/activity/review.mdc`. It holds what every reviewer applies and this file does not restate: scope (diff mode: the change; path mode: the whole file), the four shared laws, `info`, one finding per defect across lenses, and where severity comes from.

### Frontend / MobX laws

These say what is **always reported**. Its severity is the matching rule's **Review severities** table (Parts A-C) —
the canonical rubric applied, not a second opinion.

1. **Every observable mutation outside an action or `runInAction` is reported.**
   No exception for "small stores" or "simple assignments".
2. **Missing `observer()` on a component that reads MobX observables is
   reported.** The component will not react to state changes — a silent runtime
   correctness bug, and silence is exactly why nobody else will find it.
3. **An API call in a component is reported.** API/IO belongs in private store
   methods, not in JSX, hooks, or event handlers within the component file.
4. **`public` on a class member is reported.** The ESLint rule
   `@typescript-eslint/explicit-member-accessibility` with `"no-public"` forbids
   it — so the machine already catches it, which is why it is `minor` here rather
   than a merge gate.
5. **Inter-store callbacks (`onChangeX`, `handleX`, `syncX`) without `private` are
   reported.** Ask: "Is this called from JSX?" If no — it must be `private`.

---

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

Run the script from that file to determine `MERGE_BASE` (`BASE_SHA`) and `SCOPE` before proceeding.

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

---

## Step 0: Read Project CLAUDE.md

Before running the checklist, scan the project for CLAUDE.md files that define project-specific conventions:

```bash
# Project root
cat PROJECT_DIR/CLAUDE.md 2>/dev/null

# Module-level overrides (common in monorepos and large SPAs)
find PROJECT_DIR/src -name "CLAUDE.md" -maxdepth 3 2>/dev/null | xargs cat 2>/dev/null
```

Extract and note:
- MobX patterns that differ from defaults (decorator style, lifecycle names, store init patterns)
- Naming conventions (store suffix, file casing, interface prefix rules)
- Style guides and their enforcement level
- Links to external documentation
- Any patterns explicitly declared as project standard — follow them, do NOT flag as violations
- Any patterns explicitly declared as anti-patterns — flag them even if not in this skill's generic checklist

**Resolution rule:** When a project CLAUDE.md pattern conflicts with this skill's generic checklist, the CLAUDE.md pattern wins — unless it violates an Iron Law. It never overrides the canonical severity rubric: a project convention decides what is reported, not how merge-blocking it is.

If no CLAUDE.md is found, proceed normally. CLAUDE.md is optional and non-blocking.

---

## Review Checklist

### Parts A-C: the standard

Components, stores, TypeScript and stories are checked against the rules the code was written to. Read each that the change touches; each ends with a **Review severities** table, and a finding takes its level from that table's row:

- `.metaproject/rules/stacks/react/code-style-patterns.mdc`: `observer`, layers (no API/IO or business logic in components), where state lives (`useState` for UI-only state is correct), store created once, effect cleanup, keys, accessibility, TypeScript (`I` prefix, Rule 8); `any`, `!` and `src/` imports are in `.metaproject/rules/stacks/ts-js-node/coding-style.mdc` Review severities.
- `.metaproject/rules/stacks/mobx/mobx-store-template.mdc`: `makeObservable` and decorators, mutations in actions, thin public `@action.bound` over private arrow methods (`@action.bound` on a private method is a finding), async flags and the `disposed` guard, disposers and child stores, in-place collection updates, two-way sync guards, the `onMount()`/`onUnmount()` lifecycle bridge (correct, never flagged).
- `.metaproject/rules/stacks/storybook/storybook-guidelines.mdc`: which states each component's stories cover, `fn()` for actions.
- `.metaproject/rules/core/error-handling.mdc` for `catch` typing and swallowed errors.

A pattern listed under a row's **Not a finding** is not reported. A defect no row covers is rated by the canonical rubric.

### Part D: Project-Specific Patterns (populated from CLAUDE.md in Step 0)

When Step 0 finds project-specific patterns, apply them here. The examples below are drawn from a real frontend CLAUDE.md and illustrate what to look for and how to apply project conventions.

#### D1. `currentState` @computed Pattern

Some projects define a canonical `currentState` computed getter for dirty-checking, save, and snapshot:

```typescript
@computed get currentState() {
  return toJS({
    name: this.name,
    isEnabled: this.isEnabled,
    // ...
  });
}
```

- `toJS()` is required when the returned object contains observable arrays or maps
- `isEqual(this.currentState, savedState)` is the canonical dirty-check pattern
- If the project defines this pattern, flag its absence in stores that have save/cancel/dirty-check UX — **minor**
- Returning observables directly from `currentState` without `toJS()` when the result is passed outside the store — **major**
- Composite stores should compose child stores' `currentState` rather than re-declaring child state — flag manual re-declaration as **minor**

#### D2. Composite Store Pattern

Projects with root stores holding child stores may define rules for child store reference types:

```typescript
class RootStore {
  // Fixed child stores: plain property (NOT @observable — identity never changes)
  readonly childA = new ChildAStore(this);

  // Swappable child stores: @observable.shallow (identity can change, internals self-manage)
  @observable.shallow childB: ChildBStore | null = null;
}
```

- Fixed child stores must NOT be `@observable` — they never change identity; deep observation is wasted overhead — **minor** if violated
- Swappable stores MUST use `@observable.shallow`, not `@observable` — deep observation of child store internals causes double-tracking — **major** if using `@observable` on swappable stores
- Context interface (callbacks the child calls back into the parent) should be passed as arrow functions, not raw store references — flag raw store reference leak as **minor**

#### D3. JSX and Naming Conventions

When a project CLAUDE.md defines JSX and naming rules:

- String props in JSX must use braces: `label={"Save"}` not `label="Save"` — flag as **minor** if the project mandates this
- Boolean props without explicit value: `<Button disabled />` not `<Button disabled={true} />` — **minor** if the project mandates this
- Store file naming: `kebab-case.store.ts`; class name ending in `Store` — flag deviations as **minor**
- FC and ReactNode must be imported from `react`, not from `@types/react` directly — **minor** if project mandates it

---

## Output Contract

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

A finding anchored to one `file:line` is a claim about one site. The recorded
history of this repository is that a fix then repairs that site and leaves its
siblings: one writer of five, one operator instruction of four, six readers of
eight. Each was found by the *next* review round, which is why reviews here have
run to seven and four rounds instead of one.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it: enumerating the class for every low-severity
observation is theatre, not rigour.

### Status line (first line of response)

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — review complete, findings (if any) are below
- `DONE_WITH_CONCERNS` — one or more `blocker` or `major` findings found
- `NEEDS_CONTEXT` — cannot assess a finding without additional context not present in the diff (e.g., parent store file not changed but referenced)
- `BLOCKED` — cannot run git commands or access the repo

### Report structure

```markdown
STATUS: DONE_WITH_CONCERNS

## Frontend Review

### Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: default-with-uncommitted | explicit-hash-range
- Changed files reviewed: <N>

### Summary
- Blockers: <N>
- Major: <N>
- Minor: <N>
- Info: <N>

### Findings

### [F-001] Title
- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Rule**: the rule and row, e.g. `code-style-patterns` Rule 5 | `mobx-store-template` Rule 2
- **Problem**: what is wrong in the code
- **Why it matters**: concrete impact (silent non-reactivity, stale state, memory leak, etc.)
- **Fix**: concrete suggestion
- **Patch** (optional):
```diff
- wrong line
+ correct line
```

### Clean Areas
[List checklist sections with no findings, confirming they were checked]
```

### Where frontend conditions land

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`; the rules' **Review severities** tables (Parts A-C) are that rubric applied to these patterns, and this reviewer keeps no table of its own. Outside those rows: a store mutation that corrupts or loses persisted state is `blocker`, a render path that throws on an input the change admits is `blocker`, and an observation with no concrete bug is `info` (shared laws 1 and 2).


---

## Red Flags Table

Stop and re-read these rules if you are thinking:

| Rationalization | Why it's wrong |
|---|---|
| "The store is small, no need for full observer wrapping" | Missing `observer()` is reported regardless of store size — frontend law 2. It is `major`, not `blocker`: stale UI is not one of the four shapes |
| "The mutation happens in a non-async method, so runInAction isn't needed" | Mutations outside action/runInAction are always reported — frontend law 1; the rule's severity table sets the level |
| "I'll skip the API call in component to avoid friction" | API in a component is always reported — frontend law 3; `minor` unless a named defect makes it `major`, as in `review-architecture` |
| "The `public` keyword is just a style issue, I'll call it minor" | It is `minor` — but still reported. The linter fails CI on it, which is why a reviewer does not need to block merge on it too |
| "This inter-store callback works fine as public" | Frontend law 5: if it is not called from JSX, it must be `private` |
| "No spec compliance check needed for this skill" | Correct — this skill covers Stage 2 (code quality) only; spec compliance is handled by the orchestrator or review-logic |
| "I can suggest adding useCallback everywhere for safety" | With MobX+observer, useCallback is rarely needed and adds noise; only flag when concretely justified |
| "The bidirectional sync looks fine, no equality guard needed" | Bidirectional sync without an equality guard is always reported; its level follows the `mobx-store-template` table (reachability decides) |

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY carry `JOB_NAME` and `CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md`. If given and the file exists, read it before you start; use it for intentional design decisions (do not flag correct library usage), acceptance criteria when there is no `issue_url`, and the severity of edge cases the team accepted. If absent, proceed normally: context is optional and non-blocking.

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

<!-- keryx:layers-block:start -->
## Project layers: graph, tests, wiki, memory

Your payload may carry a `layers` block for your files: the files the graph says are affected, symbol neighbours, related tests, the wiki pages that describe the files and the memory entries for their module. It is bounded, and `truncated` names what was cut and the command that fetches the rest. When the diff alone does not settle a question, ask the project. Each command below is read-only and calls no model.

- `keryx gdgraph affected <file>`: who depends on the file. Use it before you call a change contained, and whenever a changed export, signature or behaviour may have callers outside your files.
- `keryx test related <file>`: the tests that cover the file. Use it before you say a behaviour is untested, and to judge whether a test would fail if the code broke.
- `keryx wiki ask "<q>"`: what the project wiki says a module is for and which rules bind it. Use it when the intent of the code is unclear and the diff does not state it.
- `keryx memory search "<q>"`: recorded lessons, decisions and known mistakes. Use it before you report a pattern the project may already have decided on, and when a failure looks like one it has seen.

In a review package, `keryx gdgraph affected <file> --data-dir <package>/layers/graph` reads the graph built at the PR head; the tracked graph may be from another commit. A finding still rests on the code you read: what a layer says is a lead, not evidence. If a layer is empty or a command fails, say so in the report instead of guessing.
<!-- keryx:layers-block:end -->
