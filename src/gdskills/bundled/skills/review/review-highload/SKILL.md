---
name: review-highload
model_tier: deep
description: |
  Use when: reviewing code that will run under high concurrency or high traffic —
  race conditions, connection pool exhaustion, cache invalidation, missing indexes,
  unbounded queues, missing backpressure, retry storms, idempotency gaps,
  hot-path blocking I/O, concurrent sessions sharing state files, lock files,
  process fan-out, and distributed systems anti-patterns.
  Dispatched by review-orchestrator.
  NOT for: frontend re-render performance (review-performance), general N+1 queries
  (review-performance), clean code style (review-clean-code), or NestJS module structure
  (review-architecture).
triggers:
  - "highload review"
  - "concurrency review"
  - "race condition"
  - "review scalability"
  - "review distributed"
metadata:
  author: "MrCipherSmith"
  version: "1.4.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review: High-Load & Scalability

Specialized reviewer for **code that runs concurrently** — under request load, or as several sessions and child processes.
Focuses on correctness under concurrency, resource contention, back-pressure, failure
modes at scale, and distributed systems invariants — not general performance profiling. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs. It runs no command unless its payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where its host gives a read-only child git (keryx shell does not: there the payload supplies the history), and the read-only layer commands the orchestrator lists (`keryx gdgraph affected|find`, `keryx test related`, `keryx wiki ask`, `keryx memory search`, `keryx ctx rg|read`); it never writes in the reviewed tree.

Reviews only changes introduced in the current branch (merge-base to HEAD).

---

## Workflow

```
High-Load Review Progress:
- [ ] Step 1: Read Job Context (if provided) — load profile, or the concrete triggers
- [ ] Step 2: Determine git scope (merge-base)
- [ ] Step 3: Collect diff and changed file list
- [ ] Step 4: CLI, TUI and multi-session concurrency (Part 0)
- [ ] Step 5: Concurrency and race conditions; resource management (connections, threads, file handles, memory)
- [ ] Step 6: Caching and cache invalidation check
- [ ] Step 7: Database access patterns under load
- [ ] Step 8: Async processing and queue patterns
- [ ] Step 9: Retry, timeout, and circuit breaker patterns
- [ ] Step 10: Idempotency and distributed invariants
- [ ] Step 11: Emit findings in unified format
```

---

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit hash or range. Overrides merge-base detection. |
| `context_doc` | string | no | Path to job context document. Read before reviewing to understand expected RPS, SLA, and load profile. |
| `load_profile` | string | no | Expected RPS, concurrent users or sessions, or traffic pattern, when a job context states it. Nothing fills it by default; without it see **No stated load** below. |

---

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

Review scope: **changes introduced in the current branch since merge-base only**.
Pre-existing problems in unchanged lines are out of scope unless the diff makes them worse.

**Supplied text first.** When the payload carries `slices`, `context_files`, `diff` or `file_contents`, review exactly that text and never rebuild the diff. A choice's history (law 4) is read with `git log`, `git blame` and `git show` only where the host gives a read-only child git; on keryx shell a read-only child has no shell and no git tool, so read the `git log -L`/`git blame` excerpts the payload supplies, or say the history was not read. Only with none supplied, collect it:
```bash
git diff --name-status "${BASE_SHA}" && git diff "${BASE_SHA}" && git ls-files --others --exclude-standard
# explicit range: <FROM_SHA>..<TO_SHA> in place of "${BASE_SHA}"
```

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

### High-load laws

1. **Every finding states its failure mode: what breaks, and under what trigger.**
   "OOM at ~1k RPS", "two sessions running `flow complete` lose one update",
   "duplicate charge on the first retry". The trigger is a stated load level or a
   concrete one the evidence shows — never an assumed traffic level.
2. **A race condition on shared mutable state is never dismissed as unlikely.**
   "It probably won't happen in practice" is not an argument; races manifest
   unpredictably under load. Its *severity* still comes from its outcome — see the
   conditions table below — but it is never dropped for improbability.
3. **An unbounded resource names what grows it.** Connections, threads, queues,
   in-memory collections, child processes: the finding names the input that grows
   it (requests, sessions, files, flows, children); the table below sets the level.
4. **Architecture opinions without a named pattern violation and a load-related
   failure mode are `info` only.** State the failure mode, not just that "it could
   be better".

---

## Review Checklist

### Part 0: CLI, TUI and Multi-Session Concurrency (check first)

For a CLI, a full-screen TUI, agent sessions and their child processes, where the
load is the number of sessions, files, flows or children rather than RPS. A
finding here cites that trigger; it needs no request handler and no load profile.

- [ ] Several sessions or processes sharing one checkout run the same command over the same state directory (e.g. `.metaproject/`) and nothing serialises them
- [ ] Read-modify-write of a shared JSON/JSONL state file with no lock and no write-to-temp-then-rename: the last writer drops the other's update, or a reader parses a half-written file
- [ ] JSONL appended from several processes in more than one write per record, so lines interleave
- [ ] Lock file created by check-then-create instead of an exclusive create (`wx`); released outside `finally`; no stale-lock recovery (holder PID or age), so a crashed holder blocks every later session; or recovery that can take a live holder's lock
- [ ] One child process, subagent or task spawned per file, flow, finding or input item with no concurrency bound
- [ ] Retry loop (spawn, lock acquire, a remote or network call) with no cap and no backoff
- [ ] Child stdout/stderr or a log accumulated whole in memory (string concatenation, array push) with no cap or ring buffer
- [ ] AbortController or timeout leaks: timer not cleared on success, a listener added to a long-lived signal per call, a child not killed when the signal aborts, a background task outliving its session
- [ ] Long-running server: per-connection state with no bound, or a broadcast to every socket with no backpressure

### Part A: Concurrency and Race Conditions

#### A1. Shared Mutable State

- [ ] Shared in-memory state (module-level variables, singleton fields, static properties) mutated from concurrent requests without a lock, mutex, or atomic operation
- [ ] Read-modify-write operations on shared counters, maps, or lists not wrapped in an atomic or transaction
- [ ] `Map` / `Set` / plain objects used as in-process caches mutated from concurrent async operations
- [ ] NestJS `DEFAULT`-scoped (singleton) service holding per-request state (e.g., `this.currentUser = ...`)

#### A2. Double-Check and TOCTOU

- [ ] Check-then-act patterns where the condition can change between check and action: `if (!exists) insert` without a unique constraint or lock
- [ ] Optimistic upsert without conflict handling (`INSERT ... ON CONFLICT DO NOTHING` with no retry)
- [ ] Token or resource validity checked before use but not at the moment of use (TOCTOU)

#### A3. Async/Await and Concurrency Primitives

- [ ] `Promise.all` used with an unbounded array of promises (can spawn thousands of concurrent operations)
- [ ] `for...of` with `await` inside where `Promise.all` would allow safe parallelism (sequential when parallel is intended)
- [ ] Missing concurrency limit: N parallel jobs where N = input size (use a concurrency limiter / semaphore for unbounded inputs)
- [ ] `async` function swallowing rejection via unhandled `.catch(() => {})` on a fire-and-forget, or a fire-and-forget call with no error handling and no queue backing

---

### Part B: Resource Management

#### B1. Connection Pools

- [ ] Database / Redis / HTTP connection created per request instead of using a shared pool
- [ ] Connection pool size not configured — using default (often 5–10 connections), which will queue at scale
- [ ] Pool exhaustion handling: no timeout on `pool.connect()`, no error boundary — requests will hang silently
- [ ] Connection opened in a function that may throw before `.release()` or `.end()` without a `finally` block

#### B2. File Handles and Streams

- [ ] File opened with `fs.open` / `fs.createReadStream` without explicit close / destroy on error
- [ ] Readable stream not consumed (memory grows indefinitely until GC or crash)
- [ ] Large file read into memory at once (`fs.readFileSync` / `Buffer.concat` on unknown-size input) — use streams

#### B3. Memory and Object Allocation

- [ ] Large objects allocated per-request that are not freed between requests, or allocated in a hot path where they could be pooled or reused
- [ ] In-process cache (plain `Map`) with no eviction policy — grows unboundedly
- [ ] Closure capturing a large object (e.g., full DB result set) in a long-lived data structure

---

### Part C: Caching

#### C1. Cache Invalidation

- [ ] Cache entry updated after a write but not invalidated for related keys (stale reads after update)
- [ ] Cache TTL set to 0 (effectively no caching) or missing on a frequently-read, rarely-written entity
- [ ] Cache key not namespaced — collision between tenants / environments
- [ ] Caching a response that contains per-user data without scoping the key to the user

#### C2. Cache Stampede

- [ ] Hot key (the evidence shows many concurrent readers) expires simultaneously for many callers — no lock-based or probabilistic early expiry to prevent stampede
- [ ] Thundering herd: cache miss triggers N concurrent DB reads for the same key with no deduplication (e.g., no mutex/semaphore on the first fetch)

#### C3. Cache Correctness

- [ ] Mutable value stored in cache by reference (not a deep copy) — mutation after storage corrupts the cache
- [ ] Cache key includes non-deterministic components (timestamp, random value, process ID)

---

### Part D: Database Access Under Load

#### D1. Missing Indexes

- [ ] Query filtering or ordering by a column not in an index on a large table
- [ ] JOIN on a column that lacks an index on at least one side
- [ ] Unique constraint missing on a column used in uniqueness checks

#### D2. Lock Contention

- [ ] `SELECT ... FOR UPDATE` on a wide row range — locks more rows than needed
- [ ] Transaction holding a lock while performing external I/O (HTTP call, file read) — lock held far too long
- [ ] Nested transactions with locks — can deadlock under concurrent writers
- [ ] Long-running migration with a full-table lock on a live table, or adding a NOT NULL column without a default

#### D3. N+1 and Unbounded Queries

- [ ] Query inside a loop where one batch query would suffice
- [ ] `findAll()` / `SELECT *` on a large table with no LIMIT/pagination
- [ ] Fetching full entity to check a single field

#### D4. Connection and Transaction Hygiene

- [ ] Transaction started but no explicit commit / rollback on all code paths (leak on exception)
- [ ] Long-lived transaction (spans multiple user interactions or HTTP calls)
- [ ] Mixing read replicas and write primary within the same business operation without awareness of replication lag

---

### Part E: Async Processing and Queues

#### E1. Queue Backpressure

- [ ] Producer adding to an in-memory queue with no max depth — under load the queue grows until OOM
- [ ] Consumer not acknowledging/nacking messages — messages redeliver indefinitely on crash
- [ ] Batch consumer with no upper bound on batch size — single batch can take arbitrarily long

#### E2. Dead Letter and Poison Pills

- [ ] No dead-letter queue for failed messages — poison pills block the consumer indefinitely
- [ ] Retry loop with no maximum retry count — failed message retried forever
- [ ] Consumer crashing on a single malformed message due to missing error handling around deserialization

#### E3. Ordering Guarantees

- [ ] Code assumes FIFO delivery on a queue that does not guarantee ordering (e.g., SQS standard)
- [ ] Parallel consumers writing to shared state where order matters

---

### Part F: Retry, Timeout, and Circuit Breaker

#### F1. Retry Safety

- [ ] Non-idempotent operation retried without idempotency key (charge, send email, create record)
- [ ] Retry with fixed delay instead of exponential backoff — causes retry storms
- [ ] No maximum retry count — code retries indefinitely
- [ ] Missing jitter on exponential backoff — synchronized retries cause thundering herd

#### F2. Timeouts

- [ ] HTTP client / DB call / queue operation with no timeout configured
- [ ] Single timeout for the full chain (outer timeout too long relative to the number of downstream calls)
- [ ] `setTimeout` as a timeout substitute for async operations that do not stop when the timer fires

#### F3. Circuit Breaker

- [ ] Repeated calls to a known-failing downstream without a circuit breaker — floods the downstream and starves the thread pool
- [ ] No fallback or graceful degradation when the downstream is unavailable, or a fallback returning stale/empty data not documented as intentional degradation

---

### Part G: Idempotency and Distributed Invariants

#### G1. Idempotency

- [ ] Webhook / event handler has no deduplication — processing the same event twice produces duplicate side effects
- [ ] API endpoint that creates a resource not accepting or generating an idempotency key
- [ ] Distributed cron/scheduled job running on multiple instances simultaneously with no distributed lock

#### G2. Distributed Consistency

- [ ] Assumption that two sequential operations form an atomic unit without a transaction or saga
- [ ] Cross-service write sequence with no compensation logic on partial failure
- [ ] Relying on eventual consistency while assuming immediate consistency (reading from cache/replica right after writing)

#### G3. Clock and ID Assumptions

- [ ] Using `Date.now()` or `new Date()` for ordering events across distributed nodes — clocks drift
- [ ] Auto-increment integer IDs expected to be globally unique across sharded databases
- [ ] UUID v1 (time-based, exposable MAC address) used where UUID v4 (random) is safer

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Race conditions, shared mutable state, concurrent writes | YES | — |
| Concurrent sessions, shared state-file writes, lock files, child fan-out | YES | — |
| Connection pool exhaustion, resource leaks | YES | — |
| Cache invalidation, cache stampede, stale reads | YES | — |
| Lock contention, long transactions, missing indexes | YES | — |
| Queue backpressure, dead letters, ordering | YES | — |
| Retry storms, timeouts, circuit breakers | YES | — |
| Idempotency, distributed locks, distributed consistency | YES | — |
| Frontend re-render performance, bundle size | NO | `review-performance` |
| General N+1 queries (not load-specific) | NO | `review-performance` |
| NestJS module structure, layer violations | NO | `review-architecture` |
| Memory leaks in React components | NO | `review-performance` |
| Logic bugs unrelated to concurrency | NO | `review-logic` |

---

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

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
- **Pattern**: Concurrency A1 — Shared Mutable State | Resource B1 — Connection Pool | etc.
- **Failure mode** (mandatory): what breaks and the trigger that breaks it (OOM at 1k RPS, a lost `flow.json` update from two sessions, duplicate charges on retry)
- **Fix**: concrete change with reference pattern (exponential backoff, connection pool, distributed lock, etc.)
- **Patch** (optional): unified diff
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no table of its own; what follows is where its recurring
conditions land under that rubric, not a second rubric.

Each row names the condition and the evidence the canonical level needs; without
that evidence the finding drops to the row's fallback level, and without a concrete trigger it is `info`.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| Race condition on shared mutable state, including a lost update to a shared state file | `blocker` **if** the interleaving can corrupt or lose data; otherwise `major` | Same wording as `review-logic`, deliberately: the outcome decides, not the word "race" |
| Check-then-act with no unique constraint or lock; non-idempotent retry; event handler with no deduplication; scheduled job or session work with no lock | `blocker` when the evidence shows the duplicate or lost write persisted (shape 2); otherwise `major` | The concurrent or retried path must exist in the code, not be assumed |
| Per-user data cached under a key not scoped to the user | `blocker` when the evidence shows a second user served the first user's entry (shape 2; shape 3 too when an attacker can steer it); `major` when a second user's request path to the key is named (trigger) but serving the wrong entry is not shown; `info` when no second reader's path is named | Blocker needs both readers shown; major needs the second reader's path named |
| `NOT NULL` column added without a default to a populated table, or a migration that fails against existing rows | `major`; `blocker` only where truncation or data loss is shown | Same rating as `review-backend` |
| Query filtering or ordering on a column with no index on a table shown to be large | `major` with the table size named; `minor` when the schema is shown but the size is not; `info` when the schema is not in the payload | Same rule as `review-performance`: reading the schema settles it |
| Unbounded queue, collection, buffer or fan-out | `blocker` only when the evidence shows the growth reaching exhaustion (shape 1); otherwise `major` with what grows it named | Law 3: the input that grows it is the trigger |
| External I/O inside a transaction or under a lock; connection without a pool; unbounded `Promise.all`; retry without cap or backoff; missing timeout; stale lock with no recovery; stampede on a hot key; N+1 on a hot path; long transaction; missing DLQ; blocking I/O on a thread or the event loop other work shares | `major` when the finding names the trigger and the stall, exhaustion or hang it causes; `blocker` only if it shows the crash | Degradation is not one of the four shapes |
| Backoff without jitter; TTL misconfigured; per-request allocation on a hot path; full-row fetch for one field; undocumented fallback | `minor` | Correct under load; the cost is to whoever tunes it next |
| Architectural note with no failure mode under a concrete trigger | `info` | Shared law 1 |

---

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

```markdown
## High-Load Review

### Review Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: `<default-with-uncommitted | explicit-hash-range>`
- Load profile: `<from context doc, or "not provided" + the concrete triggers used>`
- Changed files reviewed: <N>

### Summary
<2-3 sentences: what changed, key high-load concerns, overall verdict at scale.>

### Stats
- blocker: N  |  major: N  |  minor: N  |  info: N

### Findings

#### CLI / Multi-Session Concurrency
<[F-NNN] findings or "None detected.">

#### Concurrency & Race Conditions
<[F-NNN] findings or "None detected.">

#### Resource Management
<[F-NNN] findings or "None detected.">

#### Caching
<[F-NNN] findings or "None detected.">

#### Database Under Load
<[F-NNN] findings or "None detected.">

#### Async / Queues
<[F-NNN] findings or "None detected.">

#### Retry / Timeout / Circuit Breaker
<[F-NNN] findings or "None detected.">

#### Idempotency & Distributed Invariants
<[F-NNN] findings or "None detected.">

### Clean Areas
[List checklist sections with no findings, confirming they were reviewed]
```

---

## Job Context Awareness

When dispatched by `review-orchestrator` or `job-orchestrator`, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before reviewing. Use it to:
- Understand the expected traffic profile (RPS, concurrent users, burst patterns)
- Know the infrastructure constraints (pool sizes, queue limits, replica topology)
- Identify intentional trade-offs already accepted (eventual consistency, at-least-once delivery)
- Avoid flagging documented acceptable degradation paths as violations

If absent, proceed normally — context is optional and non-blocking.

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
| "The connection pool defaults are probably fine" | Default pools (5–10 connections) queue under concurrent use; verify against the trigger the code shows (**No stated load**) |
| "Retrying this is safe because it's idempotent" | Verify it actually is — most `POST` endpoints are not idempotent by default |
| "We'll add a circuit breaker later" | "Later" is when the downstream is down; flag it now, at the level the conditions table gives |
| "The cache invalidation is handled somewhere else" | "Somewhere else" means it will be missed — flag where the write happens with no corresponding invalidation |
| "This runs in a queue so race conditions don't apply" | Multiple consumer instances still race on shared DB rows unless explicitly serialized |
| "Using Date.now() for ordering is fine" | Clock skew across nodes makes wall-clock ordering unreliable; use logical clocks or DB sequences |
