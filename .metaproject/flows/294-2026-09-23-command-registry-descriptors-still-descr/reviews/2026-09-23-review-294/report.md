# Review — flow 294, command registry descriptors still describe pre-0.2.155 behaviour (PR #658)

Read-only review of PR #658 (worktree `keryx-reg`, branch `fix/command-registry-descriptors`):
`src/standard/command-registry.ts` descriptor corrections/additions for the commands flows
287–293 changed, `src/cli.ts` routing top-level `--help` for `flow`/`trigger`/`serve-mcp`/
`governance` to each handler's own help while keeping the mutation-guard interception, and
`flow ac update`'s "appended"/"rewritten" wording fix. The interception change was verified
empirically in a temp `keryx init` repo: `trigger install --help`, `flow ac update 1 --help`,
`governance report --help`, `serve-mcp --help` all printed the group's own rich help, exited 0,
and produced zero side effects (no `.git/hooks` write, no flow created, no governance artifact
written). Two findings were raised against the reviewed diff. Both were fixed before merge, in
commit `9f7788daa4c3186988cfcb412656409fbc49c234` ("fix(cli): say which lock each trigger
action takes, and ask the flow service what a criterion is"), which is the branch's last head
and is contained in the squash-merge commit `8ed65112694dfa759d53d1c757d704037294c37b`
(PR #658) on `origin/main`. Both fixes carry dedicated regression tests; `bun test
src/standard/command-registry.coverage.test.ts src/flow/ac-strict-args.test.ts` passes
(29 pass, 0 fail) at that commit.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (pr-verification)",
    "severity": "minor",
    "file": "src/standard/command-registry.ts",
    "problem": "The new `trigger run` command descriptor's `sideEffects` carried one blanket bullet claiming the command holds the project's shared maintenance lock (.metaproject/data/.locks/) while the action runs, for every action kind, but `flow-next` with a `dispatch` block never took that lock at all — `runFlowNextDispatch` (src/commands/trigger-dispatch.ts) instead took a separate per-flow `dispatch-<flow>.lock`, held for the whole dispatch, plus briefly a separate `spend.lock` only for the reservation decision.",
    "impact": "An agent or operator reasoning about trigger concurrency from this descriptor (the exact audience AC1 of flow 294 is for) would wrongly conclude that two `flow-next` dispatches on different flows serialize against each other through one shared lock, when in fact they run concurrently (per-flow lock). This is precisely the class of descriptor drift flow 294 exists to correct, reproduced in the very descriptor flow 294 rewrote.",
    "suggested_fix": "Split the lock claim per action kind: state the shared maintenance lock explicitly for reconcile/rebuild/open-flow, and separately state the per-flow dispatch lock (plus the brief spend lock) for a dispatching flow-next, naming both lock files.",
    "evidence": "src/trigger/run.ts:137-174 (withTriggerRunLock -> withMaintenanceLock, used by reconcile/rebuild/open-flow via src/commands/trigger.ts:220,382); src/commands/trigger-dispatch.ts:405-434 (runFlowNextDispatch takes dispatchLockPath, never withTriggerRunLock) and :143 (\"beside the maintenance lock\" — explicitly a separate lock file); src/trigger/run.ts:276-278 (spendLockPath, a third, separate lock).",
    "confidence": "high"
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (pr-verification)",
    "severity": "info",
    "file": "src/commands/flow.ts",
    "problem": "`flow ac update`'s \"rewritten\"/\"appended\" decision read the raw `--criterion` value and applied only `.toUpperCase()` before checking membership in the known-criteria list, while the service's own `validateCriterionName` (what `acUpdate` actually validates `--criterion` with) trims the value first. A `--criterion` carrying incidental whitespace (e.g. `\" AC3 \"`) would be trimmed and matched by the service (a rewrite) but reported \"appended\" by the CLI's own untrimmed pre-check.",
    "impact": "A rare, low-likelihood edge case (argv tokens seldom carry padding) producing a misleading confirmation message; no data corruption, since the actual file write follows the service's correct, trimmed normalization.",
    "suggested_fix": "Have the CLI's pre-check use the same trim-then-uppercase normalization the service applies, ideally by asking the service directly rather than re-deriving the rule a second time.",
    "evidence": "src/commands/flow.ts (pre-fix): wasKnownCriterion computed via .toUpperCase() only, no .trim(); src/flow/service.ts:111-117 validateCriterionName: raw.trim() before the uppercase/shape check. No test covered this padded-value path at review time; reasoned from code, not reproduced against a running build.",
    "confidence": "medium"
  }
]
```
