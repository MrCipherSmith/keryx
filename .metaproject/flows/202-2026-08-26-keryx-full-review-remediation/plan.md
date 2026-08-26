# Implementation Plan

Status: active

## Approach

Use bounded contract-first waves: validate claims, freeze explicit contracts, write RED tests, implement minimal seams/security boundaries, verify affected/full baselines, run independent review, and perform a fix round before handoff. This avoids a mechanical architecture rewrite and preserves existing compatibility surfaces.

## Steps

1. Restore the validated review report and versioned requirements/docpack.
2. Restore architecture/health/persistence materializer RED-to-GREEN waves and commit a durable checkpoint.
3. Complete the 14-site catch characterization; implement only the one observable-degraded path if RED proves it missing.
4. Restore web-taint/session/wiki/security-ack RED-to-GREEN behavior and commit a durable checkpoint.
5. Refresh graph and run focused tests, typecheck, build, health, and full-suite baseline comparison.
6. Run code-verifier and architecture/security/logic/testing review; fix and re-verify findings.
7. Write change report and execution metrics, then ask the required A/B/C completion choice.

## Risks

- Worktree loss demonstrated that uncommitted temp work is unsafe; use a persistent nested worktree and checkpoint commits after verified waves.
- Security persistence paths cross synchronous and asynchronous APIs; preserve public compatibility and fail closed on raw taint.
- The host currently has intermittent filesystem/process latency; use gdctx sessions and explicit test timeout only where timing, not behavior, is the cause.
