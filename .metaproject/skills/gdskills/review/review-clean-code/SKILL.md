---
name: review-clean-code
model_tier: standard
description: |
  Use when: reviewing code against Clean Code principles (Uncle Bob) and SOLID at the
  function/class level — meaningful names, small functions, single level of abstraction,
  argument count, error handling, DRY, comment quality, and SOLID (SRP, OCP, LSP, ISP, DIP)
  as applied to individual classes and functions.
  Dispatched by review-orchestrator.
  NOT for: architectural layer violations (review-architecture), naming convention formatting
  (review-style), logic correctness bugs (review-logic), or security (review-security-code).
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

- `.metaproject/rules/core/solid-principles.mdc` — the **Thresholds** table and the SOLID rules.
- `.metaproject/rules/core/error-handling.mdc` — how failure is signalled, what a message carries, `cause`, silent catches.

A threshold there is your threshold. Under it, report nothing; never apply a
stricter textbook number. Where this file and a rule disagree, the rule wins.

## Scope

Only code introduced or modified in this change.

**Debt the change did not create.** A threshold counts only when this change
crosses it. Check the before-state (diff context or base file) first. One more of
the same on code already over the line is not a finding: a line added to a
function already past the length threshold, another copy of a literal already
copied 3+ times, another parameter on a signature already at 4+. It is a finding
when the change crosses from under to over, or when the diff adds a
self-contained block that meets the threshold on its own — cite that block.

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

## Iron Laws

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot name the input, call, or condition that reaches the code, you have an observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code under review. Do not report a safe API because it could be misused, or a pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears at several sites, report it once and list every site. Ten findings that are one finding hide the other nine problems.
4. **A deliberate choice is not a defect until its reason is read and shown wrong.** An explicit override, suppression or exemption, a comment or commit giving a reason, or a sibling doing the same is a decision: read its reason (the comment, `git log -L` or `git blame`, the sibling) before you report it, and report it only when you can show that reason wrong. A project rule is checked against accepted platform practice and its known exceptions before a deviation from it is reported.

Severity levels are defined once, in `review-orchestrator/SKILL.md` →
**Severity (canonical)**. This reviewer does not restate them: `blocker` is the
four merge-blocking shapes named there and nothing else, and the `major`/`minor`
boundary is the trigger-and-outcome test.

### Clean Code laws

1. **Every finding cites a `file:line` in the diff.** No observations about the codebase in general.
2. **A naming issue is `minor`.** It reaches `major` only when the name has already produced an observable wrong outcome at a call site you can name. Naming is never a `blocker`. (`review-style` carries the identical rule.)
3. **Duplication needs 3+ copies and is `minor`**, reported once with every copy. This lens owns duplication and comments; `review-style` defers to it.
4. **A SOLID finding names the principle, the two responsibilities or the broken contract, and the impact**, or it is `info`.
5. **Language idioms and framework conventions are not violations.**

## Decision table

Each row: what to look for, when it is a finding, and its default severity. Use
your own Clean Code judgment for anything not listed, but the same tests apply:
a named site, a threshold crossed by this change, a cost someone will pay.

| Signal | A finding when | Default | Not a finding |
|---|---|---|---|
| `catch` that hides a failure | the caller then proceeds as if it succeeded | `major` — `blocker` only if the caller then persists or returns wrong data | a correct fallback with a comment giving the reason |
| Failure returned as `null` / `false` / `-1` / `[]` | a caller can read it as a valid result | `major` with that caller named, else `minor` | a type that makes absence explicit and is checked |
| Rethrow without `cause`; message without operation or input | at a module boundary / any new message | `minor` | a throw that is not a `Result`; a plain contextual `Error` inside a module |
| Log and rethrow in one `catch` | always | `minor` | — |
| Override that throws "not supported" or rejects base input | a named call site reaches it through the base type | `major`, or `blocker` on the crash/corruption outcome; else `minor` | — |
| Constructor doing I/O or async work | always | `minor`; `major` only with a named defect it causes | — |
| Function length | over 40 lines **and** two separable jobs or mixed abstraction levels | `minor` (name the jobs) | a long linear table, serializer, test or one-level sequence |
| I/O mixed with a transform | one function reads or writes (file, network, store) and transforms the data in between, at any length | `minor` (name the transform that should be a pure helper) | the transform already lives in a helper the I/O shell calls |
| Positional parameters | 4+, no options object, not a natural ordered set the codebase already uses | `minor` | — |
| Boolean flag parameter | it selects between two behaviours (`run(x, true)`) | `minor` | — |
| Output argument | a function fills a caller-supplied argument instead of returning | `minor` | — |
| Constructor dependencies | more than 5 | `minor` (name the two responsibilities) | — |
| Class or function with two change drivers | you can name both (e.g. validation + persistence) | `minor` | — |
| Branch chain over a type discriminant | 4+ branches, extended by the diff, and a map/strategy precedent exists (name it) | `minor` | no precedent in the codebase |
| Interface wider than its implementers | implementers leave methods as stubs/no-ops | `minor` | — |
| Business logic constructing its I/O, network or clock dependency | always | `minor` | a plain helper or value object built inside a module |
| Duplicated block | 3+ copies | `minor`, one finding listing every copy | 2 copies |
| Magic number / repeated string literal | business meaning, no named constant | `minor` | `0`, `1`, `100` and other neutral values |
| Name | needs a comment to be understood; generic (`data`, `result`, `temp`); two names for one concept in the diff; ambiguous boolean polarity | `minor` | loop counters; project-standard abbreviations |
| Comment | stale, contradicting the code; redundant; commented-out code; compensating for a bad name | `minor` | intent, a domain constraint, a warning, a TODO with an issue |
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
| Layer violations, module coupling, dependency direction | `review-architecture` |
| Naming convention formatting (casing, prefix) | `review-style` |
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
- **Principle**: Clean Code — names | function design | comments | error handling | DRY | SOLID — SRP/OCP/LSP/ISP/DIP
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
One `####` section per area (Naming, Functions, Comments, Error Handling, DRY,
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
