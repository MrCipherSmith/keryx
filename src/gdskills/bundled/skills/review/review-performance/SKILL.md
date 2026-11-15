---
name: review-performance
model_tier: standard
description: "Use when a performance review is requested, checking CLI/TUI hot paths (per keystroke, per file, command startup), N+1 queries, unnecessary re-renders, memory leaks, missing indexes, large bundle imports, and synchronous blocking in changed code. NOT for security, logic correctness, style, or architecture."
triggers:
  - "performance review"
  - "perf check"
  - "slow"
  - "check for perf issues"
  - "perf review"
  - "check N+1"
metadata:
  author: "MrCipherSmith"
  version: "1.3.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review: Performance (Code-Level Bottlenecks)

## Purpose

Finds real, code-level performance problems introduced in the changed code of the current branch. Covers CLI and TUI hot paths, N+1 database queries, unnecessary React re-renders, missing memoization in hot paths, memory leaks, large bundle imports, synchronous blocking in async contexts, missing pagination, and redundant API calls. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs. It runs no command unless its payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where its host gives a read-only child git (keryx shell does not: there the payload supplies the history).

This skill focuses on **measurable or high-likelihood bottlenecks** only. Premature optimization, hypothetical slowness, and style preferences are out of scope.

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
| CLI/TUI hot paths: per keystroke, per frame, per file, command startup | YES | — |
| N+1 database queries, missing eager loading | YES | — |
| Unnecessary React re-renders, missing memo/useCallback/useMemo | YES | — |
| Expensive computations in hot paths (render loops, tight loops) | YES | — |
| Missing database indexes (detectable from query patterns) | YES | — |
| Memory leaks: unbounded collections, missing cleanup, forgotten subscriptions | YES | — |
| Large bundle imports vs. named imports | YES | — |
| Synchronous blocking in async contexts | YES | — |
| Missing pagination on large datasets | YES | — |
| Redundant API calls (same data fetched multiple times) | YES | — |
| MobX: manual derived state in renders instead of @computed | YES | — |
| Security vulnerabilities | NO | `review-security-code` |
| Logic correctness, race conditions | NO | `review-logic` |
| Architecture decisions | NO | `review-architecture` |
| Code style, naming | NO | `review-style` |
| npm/bun dependency vulnerabilities, bundle analysis tooling | NO | `security-audit` / `perf-check` |

---

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

---

## Review Checklist

Work through every category below for each changed file. Tie every finding to a concrete line in the diff. For each finding, state **the hot path or execution frequency** that makes it a real problem — without that, it is INFO only.

### 0. CLI and TUI Hot Paths (check first)

For a command-line tool or a full-screen TUI, where the hot path is a keystroke, a
render frame, a file in a tree walk or a command start, not a request handler.

- [ ] Work done per keystroke or per render frame (re-reading a file, re-parsing, re-sorting, rebuilding a list) that could be done once per change of its inputs
- [ ] Per-file work in a command that walks the tree or every flow: a read, parse, `existsSync` or child spawn per entry where one pass or one batch would do
- [ ] Command startup cost: heavy top-level imports or eager reads in a module every command loads, when only some commands use them
- [ ] Synchronous I/O (`readFileSync`, `execSync`, `spawnSync`) on an interactive path: input handling, render, a prompt waiting on the user (rated by `.metaproject/rules/core/async-patterns.mdc` Rule 4, as in section 7)
- [ ] JSON parse, regex compilation or config load repeated inside a loop instead of hoisted
- [ ] O(n²) over files, flows, findings or lines: a nested scan, `.includes`/`.find` inside a loop over the same set, sort inside a loop
- [ ] Polling (`setTimeout`/`setInterval`, `while` wait loop) where an event or a single await would do

**Evidence:** a `verify-run` timing the orchestrator supplies, or a reasoned count
(calls × size: "per keystroke × a 4,000-line transcript", "per flow × every flow in
`.metaproject/flows`"). Either is the trigger law 1 asks for.

### 1. N+1 Database Queries

The standard and its severities are `.metaproject/rules/core/database-patterns.mdc` (Rule 1 and its **Review severities** row). Also: a GraphQL resolver loading a child per parent without a DataLoader is the same shape. State whether the loop runs per HTTP request, per list item render or per job iteration, with its size.

### 2. Unnecessary React Re-renders

**Detection patterns:**
- [ ] Object or array literal created inline in JSX: `<Component options={{ key: val }} />` — new reference every render
- [ ] Arrow function created inline as a prop of a non-store value; an arrow that only forwards to a store action is allowed and needs no `useCallback`
- [ ] Large expensive computation performed directly in render body
- [ ] Context value object created inline without useMemo: `<MyContext.Provider value={{ a, b }}>` — every parent render triggers all consumers
- [ ] Component receiving a new object/array reference from props despite same data (parent not memoizing)

**When memo IS justified (flag absence):**
- [ ] Pure child component receiving stable props but not wrapped in `React.memo` — only flag if the parent re-renders frequently (e.g., on keypress, scroll, animation frame)
- [ ] `useCallback` absent for a non-store callback passed to a `React.memo` child — only flag if the child is expensive; a store method or store value is never wrapped in `useCallback`/`useMemo`

**MobX note:** `observer` and where memoization does and does not belong are `.metaproject/rules/core/code-style-patterns.mdc` Rules 1 and 3. Without a concrete re-render cost there is no finding.

### 3. Expensive Computations in Hot Paths

- [ ] Sorting, filtering, or reducing a large array inside a render function without `useMemo`; when the array is store state the fix is `@computed` (`.metaproject/rules/core/mobx-store-template.mdc` Rule 1), not `useMemo`
- [ ] Deep clone (`JSON.parse(JSON.stringify(...))`) inside a loop or on every render
- [ ] Regex compilation inside a loop — should be compiled once outside: `const RE = /pattern/`
- [ ] `Object.keys().reduce()` or similar aggregation recalculated on every render instead of being derived in store or memoized
- [ ] Recursive computation without memoization called in a loop

**Hot path requirement:** An expensive computation is `major` only with a named cost and frequency (a render, a tight loop, every CLI command start: a hot path, Part 0); without both it is `minor`. Once per process (server start, a build) is `info` at most.

### 4. Missing Database Indexes

The standard and its severities are `.metaproject/rules/core/database-patterns.mdc` (Rule 2 and its **Review severities** row). Also: `LIKE '%term%'` cannot use a b-tree index; flag it as `info` with full-text search as the fix.

**Evidence requirement:** Cannot confirm an index is missing without seeing the migration or schema. If the schema is not in the payload, it is `info`: say that reading the schema would settle it.

### 5. Memory Leaks

**Event listeners and subscriptions:**
- [ ] `addEventListener` without matching `removeEventListener` in cleanup
- [ ] `setInterval` / `setTimeout` (recurring) without `clearInterval` / `clearTimeout` in cleanup
- [ ] RxJS `subscribe()` without `unsubscribe()` stored in a disposable or returned from useEffect cleanup
- [ ] WebSocket or SSE connection opened without close in cleanup

MobX disposers are `.metaproject/rules/core/mobx-store-template.mdc` Rule 5; a `useEffect` subscription, timer or async operation with no cleanup is `.metaproject/rules/core/code-style-patterns.mdc` Rule 5. Each takes its severity from that rule's table.

**Unbounded collections:**
- [ ] Map, Set, or array that grows on every event/request with no eviction, max size, or TTL
- [ ] Cache object that accumulates entries indefinitely: `const cache = {}; cache[key] = value`
- [ ] Growing error log array or history buffer without a max length

**Node.js / Server:**
- [ ] `EventEmitter` with `on()` inside a request handler — new listener per request, no removal
- [ ] `process.on('uncaughtException', ...)` registered multiple times (inside a function called per request)

### 6. Large Bundle Imports

- [ ] Default import of a large library when only one function is needed: `import _ from 'lodash'` instead of `import debounce from 'lodash/debounce'`
- [ ] `import * as Icons from '@mui/icons-material'` — imports entire icon tree
- [ ] `import { something } from 'date-fns'` — this is correct (tree-shakeable); flag `import dateFns from 'date-fns'`
- [ ] Side-effect imports pulling in large polyfills unnecessarily
- [ ] Dynamic `import()` inside a render function or tight loop (re-creates module promise)

**Evidence requirement:** Only flag if the library is known to be large (lodash, moment, antd, @mui). For unfamiliar libraries, flag as `info`.

### 7. Synchronous Blocking in Async Contexts

Sync file I/O, `execSync` and CPU-heavy work on a request path are `.metaproject/rules/core/async-patterns.mdc` Rule 4 and its **Review severities** row. Also:

- [ ] `new Promise(resolve => setTimeout(resolve, N))` — artificial sleep in a server handler
- [ ] Synchronous DB client used in an async context (e.g., `better-sqlite3` in an Express handler serving concurrent requests)

### 8. Missing Pagination

The standard and its severities are `.metaproject/rules/core/api-contracts.mdc` (Rule 6 and its **Review severities** row): a list bounded small by construction is not a finding, and attacker-reachable memory exhaustion is `blocker`. The repository-level counterpart:

- [ ] Repository query with no `take`/`limit` on a collection that could grow (user-generated content, logs, history), or `findAll()` / `find({})` with no limit on a table named as large

### 9. Redundant API Calls

- [ ] Same endpoint fetched multiple times in the same render cycle or component tree without caching
- [ ] Two sibling components each fetching the same data independently instead of sharing state / lifting to parent store
- [ ] `useEffect` with a dependency array that triggers refetch on every render due to non-primitive dependency (object identity)
- [ ] Polling without deduplication when multiple component instances are mounted

### 10. MobX: Derived State Computed in Renders

Derived values belong in `@computed` (`.metaproject/rules/core/mobx-store-template.mdc` Rule 1 and its row) and logic does not live in a component (`.metaproject/rules/core/code-style-patterns.mdc` Rule 2). This lens adds only the cost angle: a reduce, filter or format recomputed on a high-frequency render, with its frequency named.

---

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

### Performance laws

1. **Every `blocker` or `major` finding MUST cite the specific hot path or
   frequency that makes it a real problem.** "Runs on every keystroke", "called
   per list item (N = potentially thousands)", "executes on every render of a
   high-frequency parent" — be specific. For this reviewer, the execution
   frequency *is* the trigger shared law 1 asks for.
2. **Do not flag patterns outside the diff.** Review only changed code. Legacy
   issues outside the diff are `info` at most, with a note to track separately.
3. **An optimisation with no before/after is an unmeasured claim, and a neutral
   one is a finding.** Ask what was measured and on what workload. No pair at all
   is `minor` — unjustified, not wrong. A neutral pair is also `minor` (the code is
   correct; the complexity costs whoever edits it next), and its fix is a revert:
   what counts as neutral under noise, and what the attempt owes the journal, are
   `perf-check`'s Rules. Writing that entry is the author's job, not yours; a
   revert with no entry is its own `minor`.

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
- `NEEDS_CONTEXT` — cannot assess severity without additional context (e.g., expected dataset size, render frequency not determinable from diff alone)
- `BLOCKED` — cannot run git commands or access the repo

### Report structure

```markdown
STATUS: DONE_WITH_CONCERNS

## Performance Review

### Scope
- Branch `<BRANCH>`, parent `<PARENT>`, merge-base `<BASE_SHA>`, mode default-with-uncommitted | explicit-hash-range, <N> changed files

### Summary
- blocker: <N> | major: <N> | minor: <N> | info: <N>

### Findings

### [F-001] Title
- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Hot path**: where/how often this code executes (render, per-request, per-item in N-length loop, etc.)
- **Problem**: what is wrong in the code
- **Why it matters**: concrete impact (latency spike, memory growth, render thrash, etc.)
- **Fix**: concrete suggestion
- **Patch** (optional): unified diff

### Clean Areas
[List categories with no findings, confirming they were checked]
```

### Where performance conditions land

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no table of its own; what follows is where its recurring
conditions land under that rubric, not a second rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| A cost that takes the process or request down — OOM, timeout, capacity exhausted at a stated load or a named trigger | `blocker` | Crash |
| Bottleneck on a path you can name, with the frequency or data scale that makes it a cost | `major` | Trigger and outcome are both named; slow is not one of the four shapes |
| Inefficiency off any hot path you can name | `minor` | Correct today; the cost is to whoever tunes it next |
| "Looks slow", no execution context | `info` | Shared law 1 — no reproducible path |

A performance finding is `blocker` only when the degradation *is* an outage.
"Noticeably degrades UX" is `major`: real, named, and not merge-blocking.

---

## Red Flags Table

| Rationalization | Why it's wrong |
|---|---|
| "This loop iterates over user data, so N+1 is obviously a problem" | State the expected N and query cost; "user data" is not self-evidently large |
| "Missing useMemo here is a performance issue" | useMemo has overhead; only flag when the computation is measurably expensive or the component re-renders at high frequency |
| "The dataset could grow large, so I'll call it a blocker" | "Could grow" = minor or info; known to be large = major, and `blocker` only when it is an outage |
| "The optimisation measures neutral, but it does no harm — no reason to hold the diff" | The complexity it bought with no measured gain *is* the harm, and it passes review precisely because nothing in it is wrong. Neutral is `revert`, per performance law 3 |

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY carry `JOB_NAME` and `CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md`. If given and the file exists, read it before you start; use it for intentional design decisions (do not flag correct library usage), acceptance criteria when there is no `issue_url`, and the severity of edge cases the team accepted. If absent, proceed normally: context is optional and non-blocking.

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

<!-- keryx:layers-block:start -->
## Project layers: graph, tests, wiki, memory

Your payload may carry a `layers` block for your files: the files the graph says are affected, symbol neighbours, related tests, the wiki pages that describe the files and the memory entries for their module. It is bounded, and `truncated` names what was cut and the command that fetches the rest. When the diff alone does not settle a question, ask the project. Each command below is read-only and calls no model.

- `keryx gdgraph affected <file>`: who depends on the file. Use it before you call a change contained, and whenever a changed export, signature or behaviour may have callers outside your files.
- `keryx test related <file>`: the tests that cover the file. Use it before you say a behaviour is untested, and to judge whether a test would fail if the code broke.
- `keryx wiki ask "<q>"`: what the project wiki says a module is for and which rules bind it. Use it when the intent of the code is unclear and the diff does not state it.
- `keryx memory search "<q>"`: recorded lessons, decisions and known mistakes. Use it before you report a pattern the project may already have decided on, and when a failure looks like one it has seen.

In a review package, `keryx gdgraph affected <file> --data-dir <package>/layers/graph` reads the graph built at the PR head; the tracked graph may be from another commit. A finding still rests on the code you read: what a layer says is a lead, not evidence. If a layer is empty or a command fails, say so in the report instead of guessing.
<!-- keryx:layers-block:end -->
