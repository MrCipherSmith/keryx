# Review — flow 297, governance report unattended-run denials & dispatch attribution (PR #659)

Read-only review of PR #659 (worktree `keryx-govden`, branch `feat/governance-unattended-denials`):
`src/governance/*` denial/dispatch-attribution reporting, plus the additive ledger changes in
`src/trigger/{record,run}.ts`, `src/commands/trigger-dispatch.ts` and `src/commands/trigger.ts`.
Checked: (a) the not-recorded-vs-zero rule on every new figure (dispatch spend per flow,
reservations) — correct: `FlowDispatchSpend.spentUsd` stays `undefined`, never coerced to 0,
and `openReservedUsd` is tracked and rendered separately, never folded in; (b) the ledger format
change is additive and an older keryx reading a newer ledger line does not break — confirmed:
the new `dispatch.flow`/`dispatch.task` fields on a "reserved" record, and the new
`OpenReservation.flow`/`.task`, are optional TypeScript fields, and `parseRecord` (unchanged by
this PR, present already on `origin/main` before it) does loose duck-typed validation — only
`at`/`trigger`/`outcome` are checked, every other field (known or not) passes through
unvalidated; (c) whether a run could be counted twice (project trigger spend AND its flow) in a
way the report presents as a sum — CONFIRMED as a real defect at review time, reproduced by
running `buildGovernanceReport` against a fixture ledger: a single $0.42 dispatch run's cost
appeared as both `report.projects[0].triggerSpend.spentUsd` (0.42) and
`flow.dispatch.spend.spentUsd` (0.42) for the same run, presented as two unconnected figures
with no cross-reference — a consumer summing them (as the JSON's own shape invites) would
double every dispatch dollar. Fixed before merge in commit
`8b61b788e09c737334f537775c9f6eaf8bb1b216` ("fix(governance): say that a flow's dispatch spend
is part of the project total, not added to it"), the branch's last head, contained in the
squash-merge commit `ac0f1d40bcb6e41bb11d47df954157627ceb39d0` (PR #659) on `origin/main`. The
fix keeps the project figure as the TRUE total (no code path was changed to exclude
flow-attributed runs, avoiding a different bug: undercounting the true total) and instead makes
the overlap explicit and machine-checkable: `ProjectTriggerSpend.attributedToFlowsUsd` (the
subset of the project total also shown under flows) and
`FlowDispatchSpend.includedInProjectTriggerSpend: true`, plus explicit "not additive" wording in
the rendered markdown in both places. A dedicated regression test proves the non-additivity
directly (computes the naive double-counted sum and asserts it does NOT equal the report's own
total). `bun test src/governance/report.test.ts` passes (27 pass, 0 fail) at that commit.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (pr-verification)",
    "severity": "major",
    "file": "src/governance/spend.ts",
    "problem": "`summarizeProjectTriggerSpend` summed `cost.usd` over every record in the trigger ledger unconditionally, including records that now carry `dispatch.flow` (flow 297's own new attribution). `collectFlowDispatch` separately summed the subset of records attributed to each flow. The same dispatch run's cost therefore landed in both `ProjectGovernance.triggerSpend.spentUsd` (project-wide) and that flow's `FlowGovernance.dispatch.spend.spentUsd`, presented in the rendered markdown and in `latest.json` as two independent, unconnected figures with no note that they overlap.",
    "impact": "Any consumer of the governance report (an operator reading the markdown, or a script/dashboard reading governance/artifacts/latest.json) who sums the project-level trigger spend with the per-flow dispatch spend across every flow -- the natural thing to do with two apparently independent totals -- double-counts every dispatch-attributed dollar. This also runs against the frozen AC2 text ('while trigger runs without a flow stay a project-level line', naturally read as: named-flow runs do not also stay a project-level line).",
    "suggested_fix": "Either exclude flow-attributed dispatch cost from the project-wide sum, or -- what was actually shipped -- keep the project figure as the true total and make the overlap explicit and machine-readable so it can never be silently double-counted.",
    "evidence": "Reproduced directly: wrote a fixture ledger with one flow-next dispatch record ($0.42, dispatch.flow='120') and called buildGovernanceReport; got triggerSpend.spentUsd === 0.42 AND flow.dispatch.spend.spentUsd === 0.42 for the same run. src/governance/spend.ts summarizeProjectTriggerSpend (then lines ~104-129) iterated read.records with no dispatch.flow exclusion; collectFlowDispatch (then lines ~145+) separately summed the dispatch.flow === flowId subset. The pre-fix doc comment on readProjectTriggerSpend ('Never flow-attributed -- every run's cost lands in this one project-level figure') was itself stale/self-contradicting once flow 297 added flow attribution.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/governance/spend.ts summarizeProjectTriggerSpend",
        "src/governance/spend.ts collectFlowDispatch"
      ],
      "enumeration_method": "grepped src/governance for every function that sums TriggerRunsRead.records[].cost.usd (the trigger ledger's spend figures) -- exactly two: summarizeProjectTriggerSpend (project-wide) and collectFlowDispatch (per-flow). No third aggregator exists, and neither excludes what the other counts, so the class has these two members and no more."
    }
  }
]
```
