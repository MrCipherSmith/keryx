---
name: review-style
model_tier: light
description: |
  Use when: reviewing code for names, naming conventions and readability —
  without touching logic, architecture, security, or performance. Dispatched by
  review-orchestrator with the --style flag.
  NOT for: logic bugs, architectural violations, security vulnerabilities, performance
  anti-patterns, or any finding that could cause a functional regression.
triggers:
  - "style review"
  - "readability"
  - "clean up"
  - "check naming"
  - "check readability"
metadata:
  author: "MrCipherSmith"
  version: "1.3.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review — Style, Naming & Readability

Focused style reviewer. Covers names, naming conventions, readability, file length,
cyclomatic complexity, barrel and re-export hygiene, and console noise.
Never touches logic correctness, architecture, security, or performance. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs. It runs no command unless its payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where its host gives a read-only child git (keryx shell does not: there the payload supplies the history).

## The standard

Read `.metaproject/rules/core/solid-principles.mdc` before the diff: it is the
file the code was written against. Its **Readability thresholds** table is this
lens's thresholds and default severities; under a threshold, report nothing.

Names are rated by the `solid-principles.mdc` **Review severities** Name row. Not
this lens's: duplication, magic literals, comments and lookup-map or branch-chain
findings (`review-clean-code`); circular imports (`review-architecture`); unused
imports and variables and import order (the linter).

A threshold counts only when this change crosses it: one more line in a file
already past a length limit is not a finding.

---

## Workflow

```
review-style Progress:
- [ ] Step 1: Read Job Context (if CONTEXT_PATH provided)
- [ ] Step 2: Determine git scope (merge-base) — see .metaproject/skills/gdskills/shared/git-merge-base.md
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: Naming conventions check
- [ ] Step 5: Dead exports and module hygiene check
- [ ] Step 6: Readability and complexity check
- [ ] Step 7: File length and structure check
- [ ] Step 8: Console usage check
- [ ] Step 9: Emit findings in unified format, sorted by severity
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit range (e.g., `abc123..HEAD`). Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document (e.g., `<JOBS_ROOT>/<job>/ai/context.md`). |

---

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

Run that script to determine `BASE_SHA` before collecting the diff.

Only review code changed in scope. Do not flag style issues in lines outside the diff.

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

---

## Review Checklist

### 1. Naming Conventions

Casing, boolean prefixes and verb names follow the language's published defaults; report a departure only where the surrounding code follows the default.

**Variables and functions**
- Single-letter names only for loop counters and short array callbacks (`arr.map(x => x.id)`); `let x = fetchUser()` is a finding (the Name row)

**Classes and interfaces**
- Interfaces are named without an `I` prefix (`UserService`, not `IUserService`); an `I` prefix the change introduces is a finding
- Enum members: `UPPER_SNAKE_CASE` or `PascalCase` — whichever the project uses consistently; flag inconsistency

**Files and directories**
- File names match the primary export: `UserService` → `user.service.ts`
- Test files: `*.spec.ts` or `*.test.ts` next to the subject file

Naming severity is set by the Style laws below and by the canonical rubric in `review-orchestrator` — not here. A second ruling in the same file is the defect this flow removed from `review-highload` and `review-frontend`.

---

### 2. Dead Exports

- Exported functions/classes that are never imported anywhere in the diff scope — flag as `info`
  (may be used externally; do not assume dead without evidence). Unused variables, parameters and imports are the linter's.

---

### 3. Readability and Complexity

**Conditions and nesting** (clause, depth and complexity thresholds are the Readability thresholds table)
- A boolean condition over the clause threshold — suggest extracting a named predicate
- Callback or `if/else` nesting over the depth threshold — suggest extraction, `async/await` or guard clauses
- A function over the decision-branch threshold — suggest splitting into named functions
- Double negatives (`!isNotEmpty`) — flag as `minor`; rewrite to positive form
- Ternary chains (ternary inside ternary) — flag as `minor`; suggest `if/else` or early return

---

### 4. Module Hygiene

- Barrel imports (`import * as X from '...'`) without reason — flag as `info`
- Re-exporting something that is immediately re-used in the same file — flag as `minor` (unnecessary indirection)

---

### 5. Public API Docs

- Missing JSDoc on a public export: flag as `info` (`minor` where the project has a documented standard). Comment quality is `review-clean-code`'s.

---

### 6. File Length and Structure

- A file over a length threshold — suggest splitting by responsibility
- A file over the unrelated-exports threshold — suggest splitting into focused modules
- A React component file whose parts are out of order (imports, interfaces, component, helpers) — flag as `minor`

---

### 7. Console Usage

- `console.log` / `console.error` / `console.warn` in non-test production code — flag as `minor`
- Suggest replacing with project logger (`AppLogger`, `Logger`, etc.) or remove entirely
- Exception: `console.error` in the outermost catch of a CLI entry point is acceptable

---

## Iron Laws

### Shared laws (every reviewer)

Read the review activity rule before the code: `.metaproject/rules/project/activity/review.mdc` when the project keeps its own, else `.metaproject/rules/activity/review.mdc`. It holds what every reviewer applies and this file does not restate: scope (diff mode: the change; path mode: the whole file), the four shared laws, `info`, one finding per defect across lenses, and where severity comes from.

### Style laws

| Rule | Rationale |
|------|-----------|
| Style findings are **never** `blocker` | None of the four merge-blocking shapes is reachable from a style observation. This reviewer's finding format omits `blocker` for that reason |
| A naming issue is `minor`; it reaches `major` only when the name has already produced an observable wrong outcome at a call site you can name | The `solid-principles.mdc` Name row; this lens is its only rater |
| Never flag issues handled by the project's autoformatter or linter (indentation, trailing spaces, bracket style, import grouping and order, unused imports and variables) | Linter/formatter owns that; double-flagging creates noise. This does not cover the `from "src/..."` import-path row of `code-style-patterns.mdc` Rule 8, which is path style, not grouping or order |
| Do not expand scope to architectural or logic concerns | Stay in style lane; hand off to the right reviewer. Circular imports are `review-architecture`'s |

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
### [F-001] Title

- **Severity**: major | minor | info
- **File**: path/to/file.ts:line
- **Problem**: what is wrong
- **Why it matters**: readability / maintainability / convention consistency
- **Fix**: concrete suggestion
- **Patch** (optional):
  ```diff
  - old line
  + new line
  ```
```

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — no major or above findings (minor/info only or none)
- `DONE_WITH_CONCERNS` — one or more major findings (a name that has produced a named wrong outcome at a call site)
- `NEEDS_CONTEXT` — project naming convention unclear and no context doc provided; state what is ambiguous
- `BLOCKED` — cannot access diff; state reason

```markdown
# Style Review Report

<!-- No merge verdict: the orchestrator owns it. A standalone run summarizes findings only. -->

## Summary
<2-3 sentences: overall naming and readability health, notable patterns found.>

## Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Changed files: <count>

## Stats
- major: N
- minor: N
- info: N

## Major Issues
<[F-NNN] findings — names that produced a named wrong outcome>

## Minor & Info
<[F-NNN] findings>

## Positive Notes
<Optional. Consistent naming, readable structure.>
```

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|------------|-------------|
| Names, readability, barrels and re-exports, file length | YES | — |
| Duplication, magic literals, comments, lookup maps | NO | `review-clean-code` |
| Circular imports | NO | `review-architecture` |
| Logic bugs, incorrect return values | NO | `review-logic` |
| Architectural layer violations | NO | `review-architecture` |
| Security vulnerabilities | NO | `review-security-code` |
| Performance anti-patterns | NO | `review-performance` |
| NestJS/backend patterns | NO | `review-backend` |
| React/MobX patterns | NO | `review-frontend` |

---

## Job Context Awareness

When dispatched by `job-orchestrator` or called with an explicit context path, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** running scope detection.
Use it to understand:
- Project-specific naming conventions (e.g., the project uses `PascalCase` for enums, not `UPPER_SNAKE_CASE`)
- Intentional style decisions documented as agreed-upon patterns (do not flag as issues)

If absent, infer conventions from surrounding unchanged code in the same files; note any ambiguity.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The naming is a bit odd but I understand it" | Reviewers understand their own code; the next dev won't |
| "The file is 600 lines but it's organized" | Organization doesn't prevent merge conflicts and scroll fatigue |
| "An unused import is an easy minor to add" | The linter owns unused imports and variables; a finding here double-reports it |
