# Keryx Execution Observability PRD
Version: 0.2.0

## Problem

The current Execution Metrics report is useful for human comparison but several
important fields are estimated or unknown. Command counts are reconstructed from
the transcript, active time is mixed with wall time, and token/cost data is
unavailable. Testing and health `latest` artifacts can describe a different
workspace or run than the job that produced the report. Keryx also exposes
workflow inconsistencies: worktree hooks assume `.git` is a directory,
`keryx index refresh` is documented but unavailable, and `standard validate` can
fail on a baseline defect already present on `main`.

The result is good traceability but weak measurement of Keryx efficiency. A
170-minute wall-time value dominated by an environment pause cannot answer
whether Keryx made a task faster or slower.

## Goal

Make Keryx execution evidence exact where the runtime can observe it, explicit
where it cannot, and comparable across runs, branches, worktrees, and execution
modes.

## Users

- Keryx maintainers deciding which workflows reduce risk or overhead.
- Skill and orchestrator authors tuning routing, subagent waves, and lightweight mode.
- Developers comparing a direct run with a Keryx-managed run.
- Reviewers and CI operators separating task regressions from baseline failures.
- Project owners auditing artifact provenance and quality evidence.

## Requirements

### R1 — Exact event accounting

Collect shell commands, Keryx commands, tool calls, subagent dispatches, file
reads, file writes, and retries from structured runtime/gdctx events. Do not
reconstruct these counts from a compacted transcript when an event source exists.

### R2 — Active and wall time

Record `started_at`, `finished_at`, `wall_time_seconds`, `active_time_seconds`,
and paused/environment time when available. The report must explain how active
time was measured and mark it unknown when lifecycle events are unavailable.

### R3 — Provenance

Every run and every testing/health artifact must include `run_id`, schema
version, commit, branch, worktree, skill/orchestrator, parent run, and source
timestamps. The system must distinguish a worktree artifact from a project-wide
artifact.

### R4 — Versioned evidence and latest pointers

Testing and health results are immutable per-run records. `latest` is a small
pointer containing the selected run id, commit, worktree, generated time, and
source artifact path. Consumers must be able to detect stale or mismatched data.

### R5 — Worktree-safe hooks

Hooks must resolve the common Git directory with `git rev-parse
--git-common-dir`, then derive hook paths from that result. They must work when
`.git` is a file, as in linked worktrees.

### R6 — Consistent index refresh

Either implement `keryx index refresh` as a supported command with tests, or
remove it from generated instructions and replace it with the supported refresh
commands. Documentation and CLI help must agree.

### R7 — Green baseline validation

`main` must pass `standard validate` before PR-specific standard failures are
used as merge signals. Baseline defects must be tracked separately and must not
be attributed to an unrelated change without diff evidence.

### R8 — Lightweight mode

Small tasks must support a bounded mode that runs graph context, focused tests,
and one appropriate reviewer without initializing the full job pipeline. The
mode must preserve direct-user opt-in semantics and report which phases were
skipped.

### R9 — Retry taxonomy

Each retry or failed attempt must be classified as `task`, `keryx`,
`environment`, `expected-tdd`, `external`, or `unknown`, with a short reason and
whether it affected the final result.

### R10 — Paired comparison runs

Provide a documented experiment protocol for 3–5 comparable tasks run with and
without Keryx. Comparisons must include quality outcomes, active time, wall time,
tool/context volume, retries, and human intervention—not only elapsed time.

### R11 — Honest unavailable metrics

Unknown values remain `unknown`. Estimated values include a basis and never look
like exact runtime measurements. Token, cost, and model fields are populated
only when the runtime exposes them.

### R12 — Safe reports

Command metadata and artifacts must pass Keryx security redaction. Reports must
not include secrets, raw prompts, access tokens, or unredacted external output.

## Success Criteria

- A completed run has a valid schema record and a rendered Markdown report.
- Every testing and health artifact can be traced to one run, commit, branch, and worktree.
- A consumer can distinguish exact, estimated, and unknown values without reading agent prose.
- A linked worktree passes hook installation and post-commit/pre-push checks.
- `standard validate` passes on `main`, or the baseline exception is explicitly tracked.
- Lightweight mode emits a comparable report and identifies skipped phases.
- A paired experiment produces a comparison table for 3–5 tasks with no fabricated values.

## Risks

- Instrumentation overhead can itself distort active-time measurements.
- Existing artifacts lack provenance and require a compatibility/migration policy.
- Redaction can remove useful command detail if applied too aggressively.
- A green baseline may require a separate standard-schema change before this package can rely on CI.
- Comparing “with Keryx” and “without Keryx” is confounded by task and operator differences.

## Recommendation

Implement R1–R4 first as the observability foundation, then fix R5–R7 as
reliability prerequisites. Add lightweight mode and retry classification next.
Run the paired benchmark only after the first two phases produce trustworthy
provenance and active-time data.
