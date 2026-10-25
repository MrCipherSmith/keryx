# Learn probe implementation report
Version: 0.2.0

## Delivery state

Flow 470 has a working-tree implementation, not a release approval.
Scoring, artifact schemas, recovery, deduplicated evidence finalization and
retention live in `src/learning/probe*.ts`. Paired execution, owned-worktree
recovery and bounded native execution live in `src/harness/probe/`.
The CLI is `src/commands/learn-probe.ts`; help is routed by `src/cli-registry.ts`.

## Verification

Focused tests cover crash boundaries, concurrent record changes, evidence
deduplication, drift recovery, budget accounting, cleanup, retention and CLI
refusals. The real CLI help-route regression failed before the routing fix;
the subsequent CLI run passed all 15 tests.

Verified working-tree results:
- Focused tests: **489 pass, 0 fail, 1310 assertions across 14 files**;
  supervised task `task-126-86469`, exit 0. Fixture subprocesses inherited
  the repository-configured Git email; hooks remained enabled.
- Source typecheck: `tsc --noEmit`, exit 0 in the same task.
- Guards: **175 pass, 0 fail, 656 assertions across 7 files**, exit 0;
  task `task-129-1753`, log `.metaproject/data/verification/flow470-guards.log`.
- Whitespace: `git diff --check`, exit 0 in the guard verification task.

Packaging and CI test coverage regressions were subsequently fixed: the npm
pack parser accepts package-keyed output and the client matrix includes probe
and protocol tests. Package/protocol regression tests: **40 pass, 0 fail,
191 assertions**; log `.metaproject/data/verification/flow470-pack-final.log`.

The earlier full check has failures; final totals are not established (task
`task-128-88419`, `.metaproject/data/verification/flow470-check.log`). Failures
included packaging, CI coverage, Git-fixture benchmarks and schedule tests.
Their attribution is not established; no baseline comparison is claimed.
AC23 is not satisfied. Independent integration review remains outstanding;
self-review is not independent. No agents were contacted or dispatched under
the operator's self-implementation instruction. No gate was waived.
No live effectiveness measurement, commit, push, merge or release is claimed.
