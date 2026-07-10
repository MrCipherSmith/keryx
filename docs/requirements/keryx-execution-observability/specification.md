# Keryx Execution Observability Specification
Version: 0.2.0

## Identity

| Field | Value |
|---|---|
| Name | `keryx-execution-observability` |
| Kind | standard capability |
| Status | runtime capability implemented; paired benchmark not run |
| Owner | Keryx core / Metaproject maintainers |
| Canonical record | `execution-metrics-run.schema.json` |
| Human view | `run-<timestamp>.md` rendered from the canonical record |

## Architecture

1. Runtime emits lifecycle and tool events.
2. `gdctx` persists compact summaries and raw command output references.
3. A metrics collector normalizes events into one run record.
4. Testing, health, graph, and security modules attach run-scoped evidence.
5. A renderer produces Markdown for humans; JSON remains canonical for comparison.
6. A pointer updates only after the run record is finalized and integrity-checked.

The collector is observational. It must not introduce extra task work merely to
fill a metric.

## Storage Structure

```text
.metaproject/data/<primary-module>/metrics/
  runs/
    <run-id>.json
    <run-id>.md
  latest.json
```

Artifact-producing flows and packages may use their declared output root:

```text
<flow-or-artifact-root>/metrics/
  <run-id>.json
  <run-id>.md
```

Precedence is active flow root, declared artifact/output root, then the
primary-module fallback. A metrics file alone does not make a run
artifact-producing.

## Manifest and Configuration

The capability is opt-in at the user-run level and may be configured per
workspace without changing the task:

```json
{
  "metrics": {
    "enabled": true,
    "storage_root": ".metaproject/data",
    "execution_profile": "full",
    "redaction": "required",
    "retain_runs": true
  }
}
```

`execution_profile` is `full` or `lightweight`. Missing runtime values remain
unknown; configuration must never turn an unavailable value into an estimate.

## Run Record

The record must validate against
[`schemas/execution-metrics-run.schema.json`](schemas/execution-metrics-run.schema.json).
Required identity fields include:

- `run_id`, `schema_version`, `run_mode`, `skill`, `started_at`, `finished_at`;
- `commit`, `branch`, `worktree`, and `parent_run_id` when known;
- `provenance` entries for each attached testing/health/graph/ctx artifact;
- `metrics` values with `reliability: exact | estimated | unknown`;
- `retries` with the taxonomy from [Agent Protocol](agent-protocol.md);
- `final_status` and `artifact_paths`.

## Time Accounting

- `wall_time_seconds` is finish minus start.
- `active_time_seconds` sums intervals in which the top-level run is executing,
  excluding declared pauses, waits, and environment outages.
- `paused_time_seconds` is the measured or estimated remainder when lifecycle
  events permit it; otherwise it is `unknown`.
- No timing value may be presented as exact when the source only exposes a
  transcript timestamp.

## Event Sources

| Event | Preferred source | Fallback |
|---|---|---|
| shell command | runtime/gdctx event | unknown |
| Keryx command | Keryx command event | counted wrapper invocation |
| tool call | runtime event | unknown |
| file read/write | runtime or tracked file event | git for modified files |
| test result | testing run record | command output with reliability note |
| health result | health run record | command output with reliability note |
| retry | orchestrator event | explicit agent classification |

## Integration Points

- `gdctx` supplies compact command/search/read artifacts and raw event references.
- `gdskills` supplies direct-user opt-in, subagent ownership, and execution profile selection.
- `testing` and `health` attach immutable run-scoped results rather than overwriting evidence.
- `gdgraph` contributes affected context and query provenance.
- `standard` validates workspace and schema compatibility.
- `tasks` / `flow` select artifact roots and parent run ownership.
- `security` redacts report content before persistence or publication.

## CLI and Skill Surface

The implementation should expose:

```text
keryx metrics status
keryx metrics latest
keryx metrics show <run-id>
keryx metrics compare <run-a> <run-b> [--json]
keryx metrics rebuild --source <gdctx-artifact-or-log>
keryx metrics collect --events <events.json> [--run-id <id>] [--skill <name>]
keryx metrics plan --profile lightweight [--changed <file,...>]
keryx metrics benchmark init --tasks <task-a,task-b,task-c> --out <manifest.json>
keryx metrics benchmark validate <manifest.json>
```

The implementation also exposes `keryx standard baseline --baseline <status>
--pr <status>` for CI classification. It reports `baseline-green`,
`baseline-red`, or `baseline-unknown`; it does not infer provenance that CI did
not provide.

The direct-user skill contract remains the single opt-in question. Dispatched
subagents never ask or emit independent reports; the top-level caller owns one
run record and links child runs/events through `parent_run_id`.

## Hook and Refresh Contracts

- Hook installation resolves `git rev-parse --git-common-dir` and works in a linked worktree.
- Generated index instructions must reference only commands available in `keryx --help`.
- Generated guidance omits unsupported `keryx index refresh` and lists only
  commands present in `keryx --help`.

## Runtime Compatibility Notes

Testing and health writers emit immutable `artifacts/runs/<run-id>.*` files and
a pointer-shaped `artifacts/latest.json` when a run id is supplied. Their
readers accept both this pointer shape and the legacy full-report JSON shape;
`latest.md` remains a human-readable report. Existing callers without a run id
retain the legacy write path.

## Lightweight Mode Contract

Lightweight mode receives the same run id and opt-in gate, then selects:

1. gdgraph affected context;
2. focused testing (`keryx test run --changed` or equivalent);
3. one reviewer selected from changed-scope evidence.

It records `execution_profile: lightweight`, skipped phases, and the reason for
each skipped phase. It may not silently omit a required test or security gate.

## Acceptance Criteria

- **AC-1:** A run record validates against the JSON schema and renders a linked Markdown report.
- **AC-2:** A report contains commit, branch, worktree, run id, and source provenance.
- **AC-3:** `latest.json` points to a finalized run and exposes freshness metadata.
- **AC-4:** Testing and health artifacts are stored per run and can be compared without relying on mutable `latest.md`.
- **AC-5:** Linked-worktree hook installation resolves the common Git directory and passes its regression test.
- **AC-6:** Generated index and CLI help agree on index refresh behavior.
- **AC-7:** Standard validation distinguishes baseline failures from PR-introduced failures.
- **AC-8:** Lightweight mode runs the bounded profile and reports skipped phases.
- **AC-9:** Every retry has a valid taxonomy value and source note.
- **AC-10:** A paired benchmark report compares 3–5 tasks with exact/estimated/unknown labels preserved.
- **AC-11:** Security checks redact secret values without deleting required provenance fields.
- **AC-12:** Direct and dispatched skill tests prove only the top-level caller owns metrics.
