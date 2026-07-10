# Keryx Execution Observability Metrics and Validation
Version: 0.2.0

## Purpose

Define measurable signals for Keryx efficiency and the evidence needed before
claiming that one execution mode is better than another.

## Core Metrics

| Metric | Definition | Reliability requirement |
|---|---|---|
| `wall_time_seconds` | finish minus start | exact when lifecycle timestamps exist |
| `active_time_seconds` | sum of active intervals | exact or unknown; never silently equal wall time |
| `paused_time_seconds` | declared pause/environment intervals | exact, estimated with basis, or unknown |
| `keryx_commands` | Keryx command events | exact from event log |
| `shell_commands` | terminal command events | exact from event log |
| `tool_calls` | runtime tool events | exact or unknown |
| `context_files_read` | unique file-read events | exact or estimated with basis |
| `files_modified` | unique tracked files changed | git-derived exact at finalize |
| `subagents` | child run events | exact from dispatch events |
| `retry_count` | classified retry events | exact from event log |
| `tests_passed/failed` | normalized testing result | exact from testing artifact |
| `health_gate` | normalized health result | exact from health artifact |
| `keryx_overhead_seconds` | Keryx orchestration time outside task work | exact only with phase events |

## Reliability Levels

- `exact`: directly exposed by a runtime, CLI, Git, or normalized module artifact.
- `estimated`: computed from a documented approximation; include source and basis.
- `unknown`: unavailable without changing the main task or inventing a value.

## Validation Scenarios

### Scenario 1: Exact gdctx Counting

Given gdctx has structured command events,
when a run is finalized,
then command counts equal the event log and no transcript reconstruction is used.

### Scenario 2: Paused Environment Time

Given a run pauses because of a dependency or usage-limit issue,
when it resumes and finishes,
then wall time and active time are separate and the retry is classified as environment.

### Scenario 3: Provenance Mismatch

Given `latest.json` belongs to another commit or worktree,
when a consumer requests latest evidence,
then Keryx warns or rejects it and identifies the mismatched provenance.

### Scenario 4: Lightweight Run

Given a small task selects the lightweight profile,
when execution finishes,
then graph, focused tests, one reviewer, skipped phases, and their reasons are recorded.

### Scenario 5: Baseline CI Failure

Given `main` and a PR both fail the same standard check,
when CI compares them,
then the PR result is labeled baseline-red rather than attributed to the PR.

### Scenario 6: Paired Benchmark

Given 3–5 comparable tasks,
when each is run with and without Keryx,
then the report compares active time, wall time, quality, context volume, retries,
and human interventions while preserving unknown values.

## Test Strategy

- Unit-test event aggregation, active-time interval math, retry taxonomy, schema validation, and latest-pointer freshness.
- Integration-test gdctx event ingestion, testing/health provenance, linked-worktree hooks, and standard baseline comparison.
- Add regression tests for index command references and lightweight phase selection.
- Use a fixed benchmark task set and record task size, operator, model, cache state, and environment.
- Create the paired manifest with `keryx metrics benchmark init`; validate it
  with `keryx metrics benchmark validate`. Empty model/token/cost/time values
  remain `unknown` until a runtime source fills them.

## Decision Rule

Do not claim Keryx is faster from one run. Publish a comparison only when the
task set and measurement source are documented and quality outcomes are not
traded away for lower elapsed time.
