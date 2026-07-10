# Keryx Execution Observability Artifact Lifecycle
Version: 0.2.0

## Purpose

Define how execution, testing, and health evidence is created, linked, finalized,
read, and retained without confusing one worktree or run with another.

## Create

At `run_started`, allocate a unique run id and write a provisional record with
schema version, skill, mode, commit, branch, worktree, and start time. Create the
run directory before task artifacts are written.

## Append

During execution, append structured events or write immutable event fragments.
Do not rewrite a completed run. Testing, health, graph, and gdctx artifacts link
to the root run id and retain their own source timestamps. Testing and health
writers use immutable `artifacts/runs/<run-id>.json` records when a run id is
supplied.

## Finalize

At `run_finished`:

1. close active intervals;
2. classify retries and unavailable metrics;
3. run security redaction;
4. validate the JSON schema;
5. render Markdown from JSON;
6. write integrity metadata and final status;
7. update `latest.json` atomically.

If finalization fails, retain the provisional record with `final_status:
partial` and an explicit blocker.

## Latest Pointer

`latest.json` contains only pointer and freshness data:

```json
{
  "run_id": "run-...",
  "commit": "...",
  "branch": "...",
  "worktree": "...",
  "generated_at": "...",
  "record": "runs/run-....json"
}
```

Consumers must reject or warn on commit/branch/worktree mismatch instead of
silently reading a stale latest record. The runtime pointer reader reports
`fresh`, `stale`, `mismatch`, or `missing`.

## Ownership and Paths

- A flow owns reports under `<flow-dir>/metrics/`.
- A job, docpack, or declared artifact package owns reports under its output
  root's `metrics/` directory.
- Other artifact-producing skills use `.metaproject/data/<primary-module>/metrics/`.
- A dispatched subagent never creates a competing root report.

## Retention and Migration

Run records are immutable and retained according to project policy. A migration
tool may add provenance to legacy artifacts but must label fields as estimated or
unknown. Existing `latest.md` files remain readable during migration. Existing
full-report `latest.json` files remain readable; new pointer-shaped `latest.json`
files resolve to immutable run records while `latest.md` remains a rendered
compatibility view.
