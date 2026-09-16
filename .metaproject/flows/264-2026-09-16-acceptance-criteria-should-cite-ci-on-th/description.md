# Acceptance criteria should cite CI on the PR head, not a local full test run

Status: draft
Source: operator, 2026-09-16, after flows 260 and 262 each spent several minutes
of wall clock re-running the full suite locally for a gate CI had already run.

## Problem

A criterion in this repository is habitually written as some form of:

> Full gate green on the branch head: `bun test`, `bunx tsc --noEmit -p .`,
> `bun run lint`.

That wording names a **local** invocation, so satisfying it means running the
whole suite on the author's machine — 10,317 tests, ~4–6 minutes — and the
evidence recorded for the criterion is a line from a terminal nobody else can
see.

Meanwhile every pull request already runs **19 checks**: `typecheck-and-tests`,
a client matrix split four ways (terminal, streaming, cancel-resume, runtime),
a live bubblewrap sandbox smoke on Linux, real macOS legs, `opentui` native on
four platforms, `mkdocs build --strict`, `dependency-audit`,
`metrics-contract`, `standard-baseline`, `standard-pr`, `vscode-extension` and
the wiki gate.

Two facts follow:

1. The local run is a **subset** of one CI job. It duplicates work that is
   already done.
2. CI covers what a local run **cannot**: there is no macOS here, and no four
   platforms. A criterion satisfied locally is satisfied on less evidence than
   the same criterion satisfied by CI.

The local run's only genuine advantage is finding a break before it is pushed.
`main` is protected by required status checks, so a break on a feature branch
reaches nobody; the cost of learning three minutes later is small.

Nothing forces the local run today — the `pre-push` hook is a security gate,
not a test gate. What sustains it is the criterion's own wording, and habit.

## Expected Outcome

- The criteria scaffold and the flow/orchestration skills that suggest gate
  wording cite **CI on the PR head** as the evidence, naming the check run
  rather than a local command.
- Running the affected slice locally stays normal and is described as such:
  `bun run test:core`, the `test:client:*` scripts, or `keryx test related
  <file>` for the tests a change actually touches.
- Someone who wants local parity with the CI job has one command for it rather
  than a guess.

## Out of Scope

- Changing what CI runs, or adding a job.
- Changing the `pre-push` hook.
- Retrofitting closed flows. Their criteria were satisfied by the evidence they
  name; rewriting history to cite a check run that was never consulted would be
  a worse record than the one it replaced.
