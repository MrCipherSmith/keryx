---
name: review-clean-code
model_tier: standard
description: |
  Use when: reviewing code against Clean Code principles (Uncle Bob) and SOLID at the
  function/class level — small functions, single level of abstraction, argument count,
  error handling, DRY, magic literals, comment quality, and SRP, OCP, LSP and ISP as applied
  to individual classes and functions.
  Dispatched by review-orchestrator.
  NOT for: layer violations, dependency inversion and circular imports (review-architecture),
  names and readability (review-style), logic correctness bugs (review-logic), or security
  (review-security-code).
triggers:
  - "clean code review"
  - "functions do too much"
  - "solid review"
  - "maintainability"
  - "check clean code"
  - "Uncle Bob review"
metadata:
  author: "MrCipherSmith"
  version: "2.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review: Clean Code + SOLID

You know Clean Code and SOLID. This file does not teach them. It says which
project standard applies, where the project departs from the textbook, and how
to turn what you see into a finding or into silence.

Focus: maintainability of the code this change introduces, at function and class
level. Its inputs are the reviewer payload only; session memory and earlier
conversation are not inputs. It runs no command unless its payload's
`allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and
`git show` where its host gives a read-only child git (keryx shell does not:
there the payload supplies the history).

## The standard

Read both rules before the diff. They are what the code was written against.

- `.metaproject/rules/core/solid-principles.mdc` — the **Thresholds** table, the SOLID rules and **Review severities**, which rate every SRP, OCP, LSP, ISP, duplication, magic-literal and comment finding.
- `.metaproject/rules/core/error-handling.mdc` — how failure is signalled, what a message carries, `cause`, silent catches.

A threshold there is your threshold. Under it, report nothing; never apply a
stricter textbook number. Where this file and a rule disagree, the rule wins.

Ownership: this lens owns SRP, OCP, LSP and ISP at class and function level, plus
duplication, magic literals and comments. `review-architecture` owns DIP, layers,
module boundaries and circular imports; `review-style` owns names and readability.

## Scope

In diff mode, only code introduced or modified in this change.

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

## Iron Laws

### Shared laws (every reviewer)

Read the review activity rule before the code: `.metaproject/rules/project/activity/review.mdc` when the project keeps its own, else `.metaproject/rules/activity/review.mdc`. It holds what every reviewer applies and this file does not restate: scope (diff mode: the change; path mode: the whole file), the four shared laws, `info`, one finding per defect across lenses, and where severity comes from. In diff mode, **debt the change did not create** is not a finding (`solid-principles.mdc`): check the before-state first. It is a finding when the change crosses a threshold, or adds a self-contained block that meets it alone; cite that block.

### Clean Code laws

1. **Every finding cites a `file:line` in the diff.** No observations about the codebase in general.
2. **Names are `review-style`'s.** This lens reports no naming finding.
3. **Duplication needs 3+ copies**, reported once with every copy, rated by the `solid-principles.mdc` table.
4. **A SOLID finding names the principle, the two responsibilities or the broken contract, and the impact**, or it is `info`.
5. **Language idioms and framework conventions are not violations.**

## Decision table

Each row: what to look for, when it is a finding, and its default severity. Use
your own Clean Code judgment for anything not listed, but the same tests apply:
a named site, a threshold crossed by this change, a cost someone will pay.

| Signal | A finding when | Default | Not a finding |
|---|---|---|---|
| Failure paths: a hiding `catch`, failure as a value, lost `cause`, log-and-rethrow | per `error-handling.mdc` **Review severities** | as there | as there |
| SRP, OCP, LSP, ISP: override that breaks the base contract, constructor I/O, function length, I/O mixed with a transform, parameters, constructor dependencies, branch chain, two change drivers, wide interface | per `solid-principles.mdc` **Review severities** | as there (LSP `major`, `blocker` when the broken caller is in the diff) | as there |
| Duplicated block, magic literal, comment | per `solid-principles.mdc` **Review severities** | as there | as there |
| Stylistic opinion; a future issue with no current violation | — | `info` | — |

## Documentation drift — search for it

A stale comment is found by reading each doc comment **against the statement it
sits above**, for every symbol the diff touched, not only the lines it edited.
Three shapes recur and are the cheapest real findings:

- **A doc describing the rule a later change replaced.** The behaviour changed, the sentence did not.
- **A comment detached from its statement.** A line inserted between a comment and the expression it explained.
- **Two places documenting one field or behaviour oppositely**, or a comment asserting a code path that does not exist.

Where an issue or PR is cited, check it is the right one and still says what the comment claims.

## Scope Boundaries

| Concern | Use instead |
|---------|-------------|
| Layer violations, module coupling, dependency direction, DIP (`new X()` for I/O), circular imports | `review-architecture` |
| Names, naming conventions, readability | `review-style` |
| Logic bugs, off-by-one errors, null-safety | `review-logic` |
| Security vulnerabilities | `review-security-code` |
| Performance anti-patterns | `review-performance` |
| React/MobX-specific frontend patterns | `review-frontend` |

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

## Finding Format

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding carries `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set. A fix to one site that leaves its
siblings is what the next review round finds.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. `minor` and `info` may omit it.

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Principle**: Clean Code — function design | comments | error handling | DRY | SOLID — SRP/OCP/LSP/ISP
- **Problem**: what is wrong and why it matters
- **Fix**: concrete actionable suggestion
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`;
the Default column above is where this lens's conditions land under it, not a
second rubric. **Clean Code findings are `minor` by default**: a maintenance
cost, not wrong behaviour. `major` needs a named trigger and outcome.

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

```markdown
## Clean Code Review

### Review Scope
- Branch: `<BRANCH>` | Parent ref: `<PARENT>` | Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>` | Changed files reviewed: <N>

### Summary
<2-3 sentences.>

### Stats
- blocker: N  |  major: N  |  minor: N  |  info: N

### Findings
One `####` section per area (Functions, Comments, Error Handling, DRY,
SOLID): its `[F-NNN]` findings, or "No <area> issues found."

### Clean Areas
[Areas checked with no findings]
```

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY include
`JOB_NAME` and `CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md`. If the file
exists, read it first for team conventions and documented exceptions. If absent, proceed.

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "Stricter is safer, I'll flag 25-line functions too" | The threshold is the shared standard the writer followed. A finding under it is noise |
| "It's over the threshold" (when it already was before this change) | Old debt is not this change's finding |
| "The catch block logs the error, that's enough" | Logging and swallowing are the same if the caller proceeds — check what happens after the catch |
| "I can flag SOLID issues at info because they're just design opinions" | A named violation with a concrete impact is at least `minor` |
| "This is how the framework works, so it's not a violation" | Framework idioms are exempt — Clean Code law 5 |
