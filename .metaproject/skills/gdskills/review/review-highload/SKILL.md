---
name: review-highload
model_tier: deep
description: |
  Use when: reviewing code that will run under high concurrency or high traffic —
  race conditions, connection pool exhaustion, cache invalidation,
  unbounded queues, missing backpressure, retry storms, idempotency gaps,
  concurrent sessions sharing state files, lock files,
  process fan-out, and distributed systems anti-patterns.
  Dispatched by review-orchestrator.
  NOT for: frontend re-render performance (review-performance), database under load
  such as N+1 queries and missing indexes (review-performance), clean code style
  (review-clean-code), or NestJS module structure (review-architecture).
triggers:
  - "highload review"
  - "concurrency review"
  - "race condition"
  - "review scalability"
  - "review distributed"
metadata:
  author: "MrCipherSmith"
  version: "1.5.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review: High-Load & Scalability

Specialized reviewer for **code that runs concurrently** — under request load, or as several sessions and child processes.
Focuses on correctness under concurrency, resource contention, back-pressure, failure
modes at scale, and distributed systems invariants — not general performance profiling. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs. It runs no command unless its payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where its host gives a read-only child git (keryx shell does not: there the payload supplies the history).

Reviews only changes introduced in the current branch (merge-base to HEAD).

---

## Workflow

```
High-Load Review Progress:
- [ ] Step 1: Read Job Context (if provided) — load profile, or the concrete triggers
- [ ] Step 2: Determine git scope (merge-base), collect diff and changed file list
- [ ] Step 3: CLI, TUI and multi-session concurrency (Part 0)
- [ ] Step 4: Concurrency, race conditions and resource management (Part A, B)
- [ ] Step 5: Caching (Part C)
- [ ] Step 6: Lock contention and transaction hygiene (Part D)
- [ ] Step 7: Async processing and queues (Part E)
- [ ] Step 8: Retry, timeout and circuit breaker (Part F)
- [ ] Step 9: Idempotency and distributed invariants (Part G)
- [ ] Step 10: Emit findings in unified format
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit hash or range. Overrides merge-base detection. |
| `context_doc` | string | no | Job context document: expected RPS, SLA, load profile. |
| `load_profile` | string | no | Expected RPS, concurrent users or sessions, or traffic pattern, when a job context states it. Nothing fills it by default; without it see **No stated load** below. |

---

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

---

## Iron Laws

### Shared laws (every reviewer)

Read the review activity rule before the code: `.metaproject/rules/project/activity/review.mdc` when the project keeps its own, else `.metaproject/rules/activity/review.mdc`. It holds what every reviewer applies and this file does not restate: scope (diff mode: the change; path mode: the whole file), the four shared laws, `info`, one finding per defect across lenses, and where severity comes from.

### High-load laws

1. **Every finding states its failure mode: what breaks, and under what trigger.**
   "OOM at ~1k RPS", "two sessions running `flow complete` lose one update",
   "duplicate charge on the first retry". The trigger is a stated load level or a
   concrete one the evidence shows — never an assumed traffic level.
2. **A race condition on shared mutable state is never dismissed as unlikely.**
   Races manifest unpredictably under load. Its *severity* still comes from its
   outcome (conditions table below), but it is never dropped for improbability.
3. **An unbounded resource names what grows it** (requests, sessions, files, flows,
   children); the table below sets the level.
4. **Architecture opinions without a named pattern violation and a load-related
   failure mode are `info` only.**

---

## Rules This Lens Reads

Conditions a project rule already rates are rated by that rule's **Review severities** table, in `.metaproject/rules/core/`. This lens states none of them again and keeps only the calibration below.

| Condition | Rule |
|---|---|
| Lock file, state-file write, JSONL record, child fan-out, child output cap (Part 0) | `concurrency-patterns.mdc` |
| Creating endpoint with no idempotency key; unbounded list with no pagination | `api-contracts.mdc` |
| Swallowed rejection, `.catch(() => {})`, fallback that hides a failure, unhandled rejection | `error-handling.mdc` |
| Unbounded `Promise.all` / fan-out, missing timeout, `setTimeout` as a timeout, event-loop blocking, large synchronous read | `async-patterns.mdc` |
| Migration that locks a live table (Part D) | `database-patterns.mdc` |

Database under load (N+1, query in a loop, missing index, `SELECT *`, full-entity fetch) is `review-performance`'s: report none of it here.

---

## Review Checklist

### Part 0: CLI, TUI and Multi-Session Concurrency (check first)

For a CLI, a full-screen TUI, agent sessions and their child processes, where the
load is the number of sessions, files, flows or children rather than RPS. A
finding here cites that trigger; it needs no request handler and no load profile.
Lock files, state-file writes, JSONL appends, child fan-out and child output are
`concurrency-patterns.mdc` and rated by its table. This lens adds:

- [ ] Several sessions or processes sharing one checkout run the same command over the same state directory (e.g. `.metaproject/`) and nothing serialises them
- [ ] Retry loop (spawn, lock acquire, a remote or network call) with no cap and no backoff
- [ ] AbortController or timeout leaks: timer not cleared on success, a listener added to a long-lived signal per call, a child not killed when the signal aborts, a background task outliving its session
- [ ] Long-running server: per-connection state with no bound, or a broadcast to every socket with no backpressure

### Part A: Concurrency and Race Conditions

- [ ] Shared in-memory state (module-level variables, singleton fields, static properties) mutated from concurrent requests without a lock, mutex, or atomic operation
- [ ] Read-modify-write on shared counters, maps, or lists not wrapped in an atomic or transaction; `Map` / `Set` / plain objects used as in-process caches mutated from concurrent async operations
- [ ] NestJS `DEFAULT`-scoped (singleton) service holding per-request state (e.g., `this.currentUser = ...`)
- [ ] Check-then-act where the condition can change between check and action: `if (!exists) insert` without a unique constraint or lock
- [ ] Optimistic upsert without conflict handling (`INSERT ... ON CONFLICT DO NOTHING` with no retry)
- [ ] Token or resource validity checked before use but not at the moment of use (TOCTOU)

### Part B: Resource Management

- [ ] Database / Redis / HTTP connection created per request instead of using a shared pool
- [ ] Connection pool size not configured — default (often 5–10) queues at scale; no timeout on `pool.connect()`, so requests hang silently
- [ ] Connection opened in a function that may throw before `.release()` or `.end()` without a `finally` block
- [ ] File opened with `fs.open` / `fs.createReadStream` without close / destroy on error; readable stream not consumed
- [ ] Large objects allocated per request and not freed, or allocated in a hot path where they could be pooled
- [ ] In-process cache (plain `Map`) with no eviction policy — grows unboundedly
- [ ] Closure capturing a large object (e.g., a full DB result set) in a long-lived data structure

### Part C: Caching

- [ ] Cache entry updated after a write but not invalidated for related keys (stale reads after update)
- [ ] Cache TTL set to 0 or missing on a frequently-read, rarely-written entity
- [ ] Cache key not namespaced — collision between tenants / environments
- [ ] Caching a response that contains per-user data without scoping the key to the user
- [ ] Hot key (the evidence shows many concurrent readers) expires simultaneously for many callers — no lock-based or probabilistic early expiry
- [ ] Thundering herd: a cache miss triggers N concurrent DB reads for the same key with no deduplication (no mutex/semaphore on the first fetch)
- [ ] Mutable value stored in cache by reference — mutation after storage corrupts the cache
- [ ] Cache key includes non-deterministic components (timestamp, random value, process ID)

### Part D: Lock Contention and Transaction Hygiene

Migrations and indexes are `database-patterns.mdc`; query shape is `review-performance`.

- [ ] `SELECT ... FOR UPDATE` on a wide row range — locks more rows than needed
- [ ] Transaction holding a lock while performing external I/O (HTTP call, file read) — lock held far too long
- [ ] Nested transactions with locks — can deadlock under concurrent writers
- [ ] Transaction started but no explicit commit / rollback on all code paths (leak on exception)
- [ ] Long-lived transaction (spans multiple user interactions or HTTP calls)
- [ ] Mixing read replicas and write primary within one business operation without awareness of replication lag

### Part E: Async Processing and Queues

- [ ] Producer adding to an in-memory queue with no max depth — under load the queue grows until OOM
- [ ] Consumer not acknowledging/nacking messages — messages redeliver indefinitely on crash
- [ ] Batch consumer with no upper bound on batch size — one batch can take arbitrarily long
- [ ] No dead-letter queue for failed messages — poison pills block the consumer indefinitely
- [ ] Retry loop with no maximum retry count — a failed message retried forever
- [ ] Consumer crashing on a single malformed message (no error handling around deserialization)
- [ ] Code assumes FIFO delivery on a queue that does not guarantee ordering (e.g., SQS standard), or parallel consumers write shared state where order matters

### Part F: Retry, Timeout, and Circuit Breaker

- [ ] Retry with fixed delay instead of exponential backoff — retry storms; no maximum retry count; missing jitter so retries synchronise
- [ ] Single timeout for the full chain (the outer timeout too long relative to the number of downstream calls)
- [ ] Repeated calls to a known-failing downstream without a circuit breaker — floods the downstream and starves the thread pool
- [ ] No graceful degradation when the downstream is unavailable (a fallback that hides the failure is `error-handling.mdc`)

### Part G: Idempotency and Distributed Invariants

- [ ] Webhook / event handler has no deduplication — processing the same event twice produces duplicate side effects
- [ ] Non-idempotent operation retried without idempotency key (charge, send email, create record)
- [ ] Distributed cron/scheduled job running on multiple instances with no distributed lock
- [ ] Assumption that two sequential operations form an atomic unit without a transaction or saga
- [ ] Cross-service write sequence with no compensation logic on partial failure
- [ ] Relying on eventual consistency while assuming immediate consistency (reading from cache/replica right after writing)
- [ ] `Date.now()` or `new Date()` used for ordering events across distributed nodes — clocks drift
- [ ] Auto-increment integer IDs expected to be globally unique across sharded databases

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Races, shared mutable state, concurrent writes, lock files, child fan-out | YES | — |
| Connection pools, resource leaks, cache invalidation and stampede | YES | — |
| Lock contention, long transactions, queues, retries, idempotency | YES | — |
| N+1, query in a loop, missing indexes, pagination, frontend re-render, bundle size, React memory leaks | NO | `review-performance` |
| NestJS module structure, layer violations | NO | `review-architecture` |
| Logic bugs unrelated to concurrency | NO | `review-logic` |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object (it carries its own `status`, the same value as your `STATUS:` line) compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

## Finding Format

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

A finding anchored to one `file:line` is a claim about one site, and a fix then repairs that site and leaves its siblings; the next review round finds them.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
claims the class has one member. `minor` and `info` may omit `class_scope`.

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Pattern**: Concurrency A1 — Shared Mutable State | Resource B1 — Connection Pool | etc.
- **Failure mode** (mandatory): what breaks and the trigger that breaks it (OOM at 1k RPS, a lost `flow.json` update from two sessions, duplicate charges on retry)
- **Fix**: concrete change with reference pattern (exponential backoff, connection pool, distributed lock, etc.)
- **Patch** (optional): unified diff
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
Conditions in **Rules This Lens Reads** are rated by those rules' tables. This
reviewer keeps no table of its own; what follows is where its remaining
conditions land under that rubric, not a second rubric. Each row names the
condition and the evidence the canonical level needs; without that evidence the
finding drops to the row's fallback level, and without a concrete trigger it is `info`.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| Race condition on shared mutable state, including a lost update to a shared state file | `blocker` **if** the interleaving can corrupt or lose data; otherwise `major` | Same wording as `review-logic`, deliberately: the outcome decides, not the word "race" |
| Check-then-act with no unique constraint or lock; non-idempotent retry; event handler with no deduplication; scheduled job or session work with no lock | `blocker` when the evidence shows the duplicate or lost write persisted (shape 2); otherwise `major` | The concurrent or retried path must exist in the code, not be assumed |
| Per-user data cached under a key not scoped to the user | `blocker` when the evidence shows a second user served the first user's entry (shape 2; shape 3 too when an attacker can steer it); `major` when a second user's request path to the key is named (trigger) but serving the wrong entry is not shown; `info` when no second reader's path is named | Blocker needs both readers shown; major needs the second reader's path named |
| Unbounded queue or in-process buffer | `blocker` only when the evidence shows the growth reaching exhaustion (shape 1); otherwise `major` with what grows it named | Law 3: the input that grows it is the trigger |
| External I/O inside a transaction or under a lock; connection without a pool; retry without cap or backoff; stampede on a hot key; long transaction; missing DLQ | `major` when the finding names the trigger and the stall, exhaustion or hang it causes; `blocker` only if it shows the crash | Degradation is not one of the four shapes |
| Backoff without jitter; TTL misconfigured; per-request allocation on a hot path | `minor` | Correct under load; the cost is to whoever tunes it next |
| Architectural note with no failure mode under a concrete trigger | `info` | Shared law 1 |

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

```markdown
## High-Load Review
Scope: branch, merge-base, scope mode, load profile (from the context doc, or "not provided" + the concrete triggers used), files reviewed.
Summary: 2-3 sentences. Stats: blocker | major | minor | info counts.
Findings: [F-NNN] grouped under CLI / Multi-Session, Concurrency & Races, Resources, Caching, Lock Contention, Async / Queues, Retry / Timeout / Circuit Breaker, Idempotency & Distributed Invariants; "None detected." for an empty group.
Clean Areas: checklist sections with no findings, confirming they were reviewed.
```

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read it before reviewing. Use it to:
- Learn the traffic profile, the infrastructure constraints (pool sizes, queue limits, replica topology) and the trade-offs already accepted (eventual consistency, at-least-once delivery); a documented acceptable degradation is not a violation

If absent, proceed normally.

**No stated load.** Without a `load_profile` or a context document, do not assume
a traffic level. Name the concrete trigger the code shows instead: N concurrent
sessions on one checkout, a loop over every file or flow, a fan-out of children,
a retry after a failed spawn. Such a finding is rated by the conditions table like
any other — it is not `info` merely because no load was stated; it is `info` only
when no concrete trigger can be named.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "We don't have high traffic yet, so this is fine" | Correctness under concurrency does not depend on current traffic; a race condition exists at 1 RPS too |
| "Retrying this is safe because it's idempotent" | Verify it actually is — most `POST` endpoints are not idempotent by default |
| "The cache invalidation is handled somewhere else" | "Somewhere else" means it will be missed — flag where the write happens with no corresponding invalidation |
| "Using Date.now() for ordering is fine" | Clock skew across nodes makes wall-clock ordering unreliable; use logical clocks or DB sequences |
