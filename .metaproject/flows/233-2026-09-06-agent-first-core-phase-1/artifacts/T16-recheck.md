# T16 independent recheck: health completeness and Shell CLI

## Stage 1 — specification compliance

Stage 1 passed. The health implementation represents `incomplete` separately from findings and keeps coverage incomplete when a required source is skipped, filtered, missing, execution-failed, or parse-failed. Blocking findings still produce `fail` while preserving incomplete coverage. The dependency audit decoder recognizes the supported Bun package-keyed and npm modern/legacy shapes, rejects malformed nested entries and unknown severities, and preserves valid advisories from a partially malformed result. Stored and live health gates reject `incomplete`; strict warning behavior remains separate.

The Shell implementation parses before version lookup, provider discovery, session setup, renderer initialization, or readline. Help returns early. Unknown, missing, empty, invalid, and conflicting arguments receive usage advice and fail before injected startup effects. Supported alias precedence and chat permission compatibility remain covered.

Evidence:

- Current focused health suite: 15 passed, 0 failed, 86 assertions. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-26-09-087Z_run.log`; summary: `.metaproject/data/gdctx/artifacts/2026-09-06T12-26-09-087Z_run.md`.
- T21 all-health suite: 86 passed, 0 failed, 256 assertions. Raw logs are recorded in `T21-implementation.md` (`2026-09-06T12-20-14-246Z_run.log`).
- Current Shell CLI validation: 16 passed, 0 failed, 57 assertions. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-26-05-050Z_run.log`; summary: `.metaproject/data/gdctx/artifacts/2026-09-06T12-26-05-050Z_run.md`.
- Direct source CLI help: `.metaproject/data/gdctx/raw/2026-09-06T12-27-35-123Z_run.log`.
- Direct source CLI missing-value rejection: `.metaproject/data/gdctx/raw/2026-09-06T12-27-35-107Z_run.log`.

## Prior finding disposition

The original T16 F-001 reported malformed nested npm containers being accepted as clean. T21 repaired this path: malformed recognized containers/entries and unsupported severities now invalidate parse coverage, while valid advisories remain available for finding evaluation. The current focused health tests include malformed, partially malformed, supported empty, unknown-shape, and nonzero-exit cases and all pass.

## Stage 2 — logic and security

No reproducible logic defect was found. `runAdapter` keeps execution, parse, and finding outcomes distinct; a nonzero audit exit with recognized findings remains available, while a nonzero exit without findings is incomplete. `computeGate` ranks blocking findings above incomplete coverage and marks optional skips as visible warnings. Source filtering records excluded required sources rather than silently dropping them. The Shell parser's value consumption rejects option-looking or empty required values, and conflict checks occur before startup. Help and parse failures return before version/provider/session side effects.

No code-level security defect was found in the reviewed paths. The audit adapter invokes tools through argv arrays, does not shell-interpolate audit content, and normalizes advisory fields before creating findings. Shell validation prevents untrusted CLI arguments from reaching provider/session initialization until the contract is satisfied. Focused subprocess checks used a temporary directory and no credentials, model calls, or external network.

## Scope and limitations

This was a read-only recheck of health and Shell AFC05/AFC18. It did not rerun the full repository suite, dependency audit, or external providers. Repository-wide lint/type status is owned by the parent and is not claimed here. The health wiki page and graph affected-context output were consulted; the graph reports the current source blast radius but may be stale for concurrent uncommitted edits.

Routing audit: `graph_used: yes`, `wiki_used: yes`, `ctx_used: yes`, `raw_rg_used: no`.
