---
name: review-frontend-conventions
model_tier: standard
description: |
  Use when reviewing frontend code against repository-local conventions commonly
  captured in CLAUDE.md or similar project guides: React/MobX boundaries,
  TypeScript strictness, i18n placement, storage wrappers, error handling,
  styling tokens, Storybook expectations, and local tooling rules. Dispatched
  by review-orchestrator for --frontend-conventions, --project-conventions,
  --all, or frontend src/**/*.ts(x) changes when local convention docs exist.
  NOT for: generic React and MobX correctness with no local rule behind it
  (review-frontend), what the CSS actually renders (review-layout), or naming and
  readability as a matter of taste (review-style).
triggers: ["frontend conventions", "local frontend rules", "CLAUDE frontend", "review frontend conventions"]
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "review"
  stack_requires: "react,mobx"
  overlap_group: "frontend"
  overlap_rank: "generic"
license: "MIT"
---

# Review — Frontend Conventions

Reviewer for frontend repository conventions that are more specific than generic React/MobX
correctness. Use it alongside `review-frontend`, `review-style`, `review-performance`, and
`review-logic`. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs. It runs no command unless its payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where its host gives a read-only child git (keryx shell does not: there the payload supplies the history).

Before reviewing, read the nearest project guide files if they exist: root `CLAUDE.md`,
`AGENTS.md`, `.junie/guidelines.md`, `ARCHITECTURE.md`, and module-level `CLAUDE.md` files.
The checklist below is a neutral baseline; local project rules win when they are stricter.

---

## Scope

Review changed frontend source, stories, tests, and UI wrapper files for local conventions.
Do not flag unrelated generic React/MobX issues unless they also violate a local convention or
the baseline below.

If no local convention document exists, run only the neutral baseline and state that no
project-specific guide was found.

---

## Checklist

### Styling and UI

- Prefer the repository's styling system consistently (Tailwind, CSS modules, design tokens, or
  the established local framework).
- Avoid inline `style` except for genuinely dynamic positioning or third-party integration seams.
- Theme colors and spacing come from local tokens, not ad hoc literals.
- Use the established UI kit and wrapper layer; do not bypass shared wrappers without a reason.
- Reuse existing icons/assets before adding new ones.

### TypeScript

- Avoid broad `as` casts. Prefer type guards, discriminated unions, and precise types. `any` and `!` are `.metaproject/rules/stacks/ts-js-node/coding-style.mdc` Review severities; the `I` prefix is `.metaproject/rules/stacks/react/code-style-patterns.mdc` Rule 8.
- Keep tests and stories typed unless intentionally exercising invalid edge cases.
- Follow local React type import conventions consistently.
- Write new code in the direction of stricter compiler settings.

### React Components and State Stores

Components follow `.metaproject/rules/stacks/react/code-style-patterns.mdc` (reactive wrapper, thin components, where state lives, effects and cleanup, props naming) and stores follow `.metaproject/rules/stacks/mobx/mobx-store-template.mdc` (naming and file casing, reactivity in the constructor, member order, `@action.bound` on public UI-called methods only, actions around async mutations). Each takes its severity from that rule's **Review severities** table, and a local guide that is stricter wins. Local `useState` for UI-only state and a memo over non-store values are correct. Beyond the rules:

- Derived serializable state has a single source of truth such as `currentState` when that is the
  local pattern.

### i18n, Storage, and Errors

- Translations happen at the view/render boundary unless local architecture says otherwise.
- Do not hide missing translations with inline fallbacks when the project expects JSON/catalog
  entries.
- Browser storage goes through shared wrappers/adapters; direct `localStorage`/`sessionStorage`
  access is a review finding when wrappers exist.
- Catch blocks notify through the established UI notification channel and normalize user-facing
  messages; keeping the cause and logging once are `.metaproject/rules/core/error-handling.mdc` Rules 3 and 5.

### Stories and Tooling

- New reusable UI surfaces have stories or examples matching local standards; which states they cover is `.metaproject/rules/stacks/storybook/storybook-guidelines.mdc` Rule 2.
- Wrapper components expose plain props for controls when the primary component is store-only.
- Treat unused-code tools as signals: preserve intentional public APIs with narrow ignores rather
  than deleting documented runtime/story/test entrypoints.

---

## Iron Laws

### Shared laws (every reviewer)

Read the review activity rule before the code: `.metaproject/rules/project/activity/review.mdc` when the project keeps its own, else `.metaproject/rules/activity/review.mdc`. It holds what every reviewer applies and this file does not restate: scope (diff mode: the change; path mode: the whole file), the four shared laws, `info`, one finding per defect across lenses, and where severity comes from.

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object (it carries its own `status`, the same value as your `STATUS:` line) compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

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

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what local frontend convention is violated
- **Why it matters**: runtime behavior, maintainability, CI, UX, or developer workflow impact
- **Fix**: concrete project-aligned change
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no rubric of its own; what follows is where its recurring
conditions land under that rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| Unguarded direct storage writes that can throw on quota | `blocker` | Crash on a reachable input |
| Lost reactivity (`code-style-patterns.mdc` Rule 1 row); a masked translation | `major` | Named trigger and named outcome. Identical to `review-frontend`'s rating for lost reactivity, deliberately. An error path is rated by `error-handling.mdc`, not here |
| A convention violation the linter or CI already fails on | `minor` | The machine catches it; a reviewer restating it is not a merge gate |
| Naming, story coverage, file placement | `minor` | Correct today; the cost is to the next editor |
| A convention preference with no named consequence | `info` | Shared laws 1 and 2 |

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "There is no project guide here, but I know what good React looks like." | Then you are running the neutral baseline, and you must say so in the report. A preference with no local rule and no named consequence is `info`, not a convention violation — this lane's authority comes from the project's own documents. |
| "The guide says one thing but the newer files all do another, so that is the convention." | A pattern repeated in code is a candidate convention, not a decision. Cite the guide and name the divergence; let the team choose which one moves. |
| "The linter already fails on this, so it is at least `major`." | The machine catches it before merge. A reviewer restating a lint error spends a merge gate on something no human can ship past, which is why the rubric above puts it at `minor`. |
| "It is one direct `localStorage` call — the wrapper is overkill here." | The wrapper exists because the raw API throws on quota and is absent in some environments. One unguarded call is the class; enumerate the others before deciding it is small. |
| "This component does not read observables, so it does not need the reactive wrapper." | Check what it reads through props and through the store getters it calls. Lost reactivity is silent, which is why it is rated the same here as in `review-frontend`. |
| "The inline `style` is dynamic, so the token rule does not reach it." | Only the computed part is dynamic. Colours and spacing inside it still come from the local tokens, and mixing the two is how a theme change stops applying to one surface. |

---

## Verification

Report done only once all of these hold:

- The report names which local convention documents were found and read, or
  states plainly that none exist and only the neutral baseline ran.
- Every finding cites the local rule it rests on — the guide, the lint config, or
  the baseline section above — and names `file:line`.
- Every `blocker` and `major` carries `class_scope` with `sites` and an
  `enumeration_method` naming the search that produced them.
- No finding invents a severity: each lands under **Severity (canonical)** in
  `review-orchestrator/SKILL.md`.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, or
  `NEEDS_CONTEXT` naming the context that was missing — never a guess in its place.

