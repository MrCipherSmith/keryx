# Keryx Project Agent Harness Artifact Lifecycle
Version: 0.2.0

## Ownership

The harness separates source-of-truth configuration from generated execution
artifacts:

| Artifact | Owner | Mutation rule |
|---|---|---|
| `harness.config.json` | user/Keryx lifecycle | seed-once, merge-safe |
| role/policy definitions | user/project | explicit user or command change |
| session event log | harness session store | append-only |
| run output | harness coordinator | atomic finalize |
| context manifest | context builder | immutable per context hash |
| evidence ledger | harness coordinator | append-only, redacted |
| flow state | Task Manager | CLI/service only |
| tests/health/security reports | owning modules | module-specific artifact rules |
| cache | harness | disposable, hash-addressed |

## Session Layout

```text
sessions/<session-id>/
  manifest.json
  session.jsonl
  context-manifest.json
  events.jsonl
  evidence.jsonl
  checkpoints/<checkpoint-id>.json
  artifacts/<artifact-id>.*
  output.json
```

The session log is the source for reconstruction. `manifest.json` and
`output.json` are derived/final views with hashes of the source log.

## Run Lifecycle

1. `created` — input validated and run id allocated.
2. `context-building` — context manifest being prepared.
3. `ready` — policy, provider, role, and budget resolved.
4. `running` — model/tool loop active.
5. `waiting-approval` — blocked on explicit user approval.
6. `paused` — user/system pause or external blocker.
7. `verifying` — completion gates running.
8. `completed` — gates passed and output finalized.
9. `failed` — terminal failure with typed reason.
10. `cancelled` — user/system cancellation.

## Tool Execution and Recovery Lifecycle

A side-effecting tool has a separate durable state machine:

`prepared` → `executing` → `succeeded | failed | cancelled | outcome-unknown`
→ `reconciled`.

The prepared record, canonical input/schema/registry hashes, idempotency key,
and approval binding are persisted before execution. A receipt and result are
persisted before a terminal success is accepted. After a crash, timeout, or
cancellation, a non-idempotent tool with an uncertain effect is
`outcome-unknown`; automatic retry is prohibited until a reconciliation probe
records a result. Cancellation records request, acknowledgement, escalation,
process-group outcome, and side-effect certainty.

## Atomicity Rules

- Append events using a lock or atomic append strategy.
- Write large artifacts to a temporary file, scan/redact, then atomically
  rename.
- Update derived pointers only after the canonical record validates.
- If validation fails, keep the invalid candidate under a failure artifact and
  do not advance the current pointer.
- Never overwrite an accepted attempt; create a new attempt number.

## Resume and Reuse

Reuse is allowed only when these fingerprints match:

- project root/worktree and commit/content identity;
- task target and scope;
- context manifest hash;
- role and policy fingerprint;
- provider/model policy fingerprint;
- skill/rule versions;
- schema versions.

Any mismatch invalidates the current result for reuse but preserves it for
history. A changed context may reuse immutable evidence that remains relevant,
but not an accepted model decision that depended on the old context.

## Compaction

Compaction creates a new event containing:

- summary;
- first retained entry id;
- tokens before/after with reliability;
- read/modified file sets;
- active task and acceptance references;
- unresolved approvals/errors;
- evidence ids preserved across the cut.

Compaction must never discard tool results needed to explain a file mutation or
completion gate.

Compaction is a typed, derived entry with source entry range/hash, retained
cursor, summarizer metadata, redaction and reliability state. It is untrusted
derived context until preserved task, approval, error, and evidence invariants
validate. A branch has `branchId`, `forkEntryId`, a current leaf, and immutable
ancestors; branch merge is excluded from v1.

## Replay Modes

- `validate-log` validates ordering, hashes, and transitions without invoking a
  provider or tool.
- `simulate-recorded-results` consumes definition/input/hash-bound recorded
  provider and tool fixtures; it performs no network, provider, or mutating
  call.
- `isolated-re-execute` is deferred and requires dedicated containment and
  policy acceptance.

Replay reports typed mismatch categories and never accepts a model-provided
`replayable` flag as authority.

## Caching

Cache keys must include operation, input hash, project scope, policy hash, and
schema version. Cache entries must declare freshness and replayability.

Never cache a mutating tool result as permission to repeat the mutation.

## Retention

Defaults:

- keep active and completed session manifests;
- retain event logs according to project policy;
- retain final evidence and failed-attempt summaries;
- allow explicit pruning of raw output while preserving hashes and summaries;
- never prune flow state or frozen acceptance criteria through the harness;
- never prune security incident records automatically.

## Migration

Every schema change must provide:

- schema version bump;
- read compatibility or explicit migration;
- migration test over at least one prior fixture;
- preservation of stable ids and evidence references;
- a report when migration cannot preserve a field.
