# Learn Probe Artifact Lifecycle
Version: 0.2.0

## Storage and ownership

All paths below are under `.metaproject/data/learning/probes/<pattern-id>/<probe-id>/`.
Runtime is not implemented. These are planned artifacts, not records already produced.

| Artifact | Owner | Lifecycle |
|---|---|---|
| plan.json | probe planner | immutable snapshot/environment/request, once before seeds |
| checkpoint.json | probe orchestrator | atomic mutable seed/spend/finalization state |
| comparison.json | probe scorer/publication | immutable measurement, never rewritten |
| runs/base/<seed>.ndjson, runs/probe/<seed>.ndjson | arm runner | raw transcripts, retention applies |
| evidence in candidate record | existing learning store | dedup by probe sourceRef under scope lock |

Schemas, exact hash encoding, containment and lock ordering are normative in
[specification](specification.md), §§3 and 6.5–6.6. Plan/checkpoint/comparison
are retained for the life of the pattern, including rejected/expired patterns.
Only finalized transcript directories count toward retainRunsPerPattern (default
20). The planned third prune pass removes oldest runs/ only; it preserves audit
JSON, skips locked/unfinalized probes and leaves today's two passes unchanged.
The probes data root is gitignored by a planned init guard, not checked in as data.

## Identity and resume

Eight identity inputs include trigger/action digest as well as pattern ID;
retain full SHA-256 to detect collisions at the 12-hex directory name. A different
measurement gets a different identity. Same identity resumes only matching
immutable environment/request/snapshot and plan-linked checkpoint. Mismatch is
probe-environment-mismatch exit 2/no writes, never a silent restart.

Published comparison alone is NOT completion. Recover pending finalization
without models or rescoring; only checkpoint phase finalized means completed.
Finalized rerun (including skipped evidence) refuses already-completed exit 2,
zero writes. Comparison remains byte-identical across every recovery.
When text/status changes after publication, locate pending original plan as
specified in §3; do not strand it behind new-run eligibility checks.

## Persistence and crash matrix

| Crash boundary | Recovery |
|---|---|
| After plan/before checkpoint | reconstruct empty checkpoint from intact immutable plan |
| After running reservation/before confirmed completion | retain charge conservatively; mark failed; no blind replay |
| After completed seed checkpoint | reuse complete transcript/result/spend, never parse a torn tail as success |
| During scoring/before comparison | score durable checkpoints, matching environment only |
| After comparison/before evidence | finalization only, no model call and no comparison rewrite |
| After evidence/before marker | receipt dedup recovers applied; confidence not applied twice |
| After finalized marker | rerun exit 2 unchanged, including a finalized skip |

Before any paid call persist running state/reservation; cumulative usage survives
restart. Unknown interrupted usage consumes its reservation. Atomic checkpoint
completion is the seed reuse boundary. Persistence failures remain observable
operational errors, not fabricated completion. Concurrent invocations use probe
then scope lock; record append uses the existing locked updatePattern primitive.

## Drift cut-off

Immediately before atomic publication, scope-locked text/status mismatch yields
unmeasurable/environment-drift with null arms/delta, retaining actual runs.
After publication, comparison is immutable. Locked finalization first checks for
an already-applied receipt; otherwise text/status drift skips evidence without
changing confidence. Checkpoint records evidence=skipped/reason=environment-drift;
CLI reports separate finalization outcome, exit 3 on the invocation recording it.
A prior committed receipt remains applied, never undone by later drift.

## Cleanup and safety

Both arms use disposable owned worktrees at the same resolved commit. Verify all
gold paths exist in base, remove/verify in both before any seed. Graceful failures
and SIGINT/SIGTERM remove worktrees and persist run-failed when possible. SIGKILL
and power loss cannot run cleanup; recovery reconciles stale owned worktrees
before creating others. Never delete unrelated worktrees. Plan/checkpoint and
transcripts can contain project text; no publication/upload/scheduling is implied.
Deletion beyond transcript retention is a separate explicit operator action.
