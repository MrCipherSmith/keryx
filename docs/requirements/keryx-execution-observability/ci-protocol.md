# Keryx Execution Observability CI Protocol
Version: 0.2.0

## Purpose

Prevent baseline workspace defects from obscuring the quality signal of a PR
that changes execution observability.

## Baseline Gate

Before relying on a PR's `standard validate` result, CI must run the same check
on the current `main` commit. The result is classified as:

- `baseline-green` — main passes and PR failures are attributable candidates;
- `baseline-red` — main already fails; PR status is diagnostic, not an isolated regression claim;
- `baseline-unknown` — baseline could not be run or provenance is missing.

The historical example was a gdgraph module-schema mismatch where capabilities
were objects but the validator expected strings. The runtime schema now accepts
the object form and the branch's `standard validate` baseline is green; CI must
still run the independent main baseline and classify it rather than infer this
from the PR result.

## Required CI Jobs

1. `typecheck-and-tests` — typecheck and full tests.
2. `standard-baseline` — validate current main and publish provenance.
3. `standard-pr` — validate the PR and classify against baseline.
4. `metrics-contract` — schema, provenance, latest-pointer, hook, and lightweight-mode tests.

The normalized comparison step may use:

```bash
keryx standard baseline --baseline pass|fail|unknown --pr pass|fail|unknown
```

This command is classification-only. CI owns the independently measured main
and PR provenance and must not pass an unverified status string.

## Failure Reporting

Each job reports commit, branch, worktree (or CI workspace), run id, command,
status, and artifact path. A failure must identify whether it is task,
Keryx, environment, external, or baseline-related.

## Hook Compatibility

CI and local hook tests must cover ordinary clones and linked worktrees. Hook
installation must derive the common Git directory rather than assuming
`.git/hooks` is directly writable.
