# Module src/governance

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/governance` assembles the read-only governance report: review spend, acceptance confirmations, completion signatures, gate outcomes and unattended trigger spend, unified across flows and, optionally, across registered projects. It renders the report as a markdown and JSON artifact pair. It groups 9 file(s), depends on `src/flow`, `src/lib`, `src/review` and `src/trigger`, and exposes 13 public symbol(s).

## Overview

`src/governance` owns the governance report, the accountability view over flows and trigger runs: who owns and confirmed each acceptance criterion, what each flow's review rounds and dispatched runs cost, which gate attempts were recorded, and how much is reserved but not spent. It is strictly read-only over recorded artifacts (`flow.json`, review manifests, the trigger ledger). It never re-runs a gate or calls a provider, and it writes only its own `latest.md` and `latest.json` under `.metaproject/data/governance/artifacts`. Callers such as the governance command and the TUI reach it only through `src/governance/service.ts`.

## How it works

The module has four layers. `service.ts` is a facade that re-exports the public surface and is deliberately kept out of `src/core.ts`, so the published package's owner list does not change. `report.ts` assembles and persists the report: `buildGovernanceReport` walks the current project and, with `allProjects`, every registry entry. A project whose path is missing or whose read throws becomes a `state: "skipped"` entry with a reason instead of failing the whole report. `aggregate.ts` is the per-project layer. `collectProjectGovernance` reads the trigger ledger once and shares it with `collectFlowGovernance`, which builds one `FlowGovernance` per flow directory, and `filterFlows` applies `--flow`, `--owner` and `--since`/`--until` against each flow's `updatedAt`. `spend.ts` holds the pure readers: `summarizeReviewSpend` sums each figure only over the rounds that reported it, `summarizeProjectTriggerSpend` computes the project total, and `collectFlowDispatch` slices the same ledger per flow.

The key abstraction is `types.ts`. Its unions (`absent | unreadable | present`, or `recorded: false`) keep "not recorded" distinct from zero, so an unmeasured cost never shows as `$0`. `renderGovernanceMarkdown` is the human half of the artifact pair, and `writeGovernanceArtifacts` writes the markdown first and `latest.json` last, both atomically, so that the JSON file the TUI watcher and `show` read always matches the markdown beside it. `readLatestGovernanceReport` shape-guards the stored JSON and returns `absent`, `malformed` or `present` rather than trusting it.

## Key concepts

- **GovernanceReport**: `schemaVersion` 1, `generatedAt`, the applied `filters`, `allProjects`, and one `ProjectGovernance` per project.
- **ProjectGovernance**: `state` (`ok` or `skipped`), its `flows`, the project-wide `triggerSpend`, and a `policyDecisions` note. The note states that interactive sessions' own allow/ask/deny decisions are not recorded anywhere in this build.
- **FlowGovernance**: per flow, `spend` (review rounds), `confirmations`, `gateOutcomes`, `acceptance`, `dispatch`, plus the stated `effect` and a derived `summary`.
- **ProjectTriggerSpend vs FlowDispatch**: a flow's dispatch spend is a slice of the project total, never an addition to it. `attributedToFlowsUsd` is the subset of the project total that is also shown under flows, and the rendered lines say "not additive" so a reader does not sum them.
- **Open reservation**: a ledger `reserved` record that no closing record or `keryx trigger resolve` has closed. It counts toward `runsTotal` and is reported as "reserved, not spent".
- **Acceptance coverage**: each criterion's verification kind (`exec`, `invariant`, `judged`, `none`, or `unclassified`). `exec` and `invariant` count as runnable. A flow frozen before kinds existed reads as fully unclassified, never as `0/0`.
- **Identity and confirmations**: an `Identity` carries a value and a basis. A criterion confirmation is joined to its `ac-confirm` signature, and a completion signature may carry a terminal confirmation token, which the render marks as "an interactive step, not proof of who".

## Main flows

1. **Building and saving a report.** `buildGovernanceReport` (`report.ts`) takes the current root, plus registry entries under `allProjects`. Each root goes through `collectProjectGovernance` (`aggregate.ts`), which calls `readTriggerRuns` once, then `collectFlowGovernance` for each flow directory. Each flow's review spend, confirmations, gate outcomes and acceptance are summarized by `spend.ts` and the accountability readers, and `collectFlowDispatch` slices the ledger for that flow. `filterFlows` applies the filters, and `summarizeProjectTriggerSpend` produces the project total. The result goes to `writeGovernanceArtifacts`, which writes `latest.md` and then `latest.json`.

2. **Reading the stored report.** `readLatestGovernanceReport` checks that `latest.json` exists and parses to an object, then checks for `schemaVersion`, `generatedAt` and `projects`. A missing file is `absent`, and a file that fails the check is `malformed` with the reason. Only a file that passes is `present`. The TUI watcher and the `show` view read this file, and they treat `absent` or `malformed` as "no report yet".

3. **Attributing a trigger run to a flow.** A dispatch run writes a `reserved` record, then one closing record with the same run id. `closingRecordFlows` takes a closing record's `dispatch.flow`, or, for an operator's `reservation-resolved`, the flow of the reservation it closes. Closed runs with a flow go into that flow's `FlowDispatch.runs` and into `attributedToFlowsUsd`. A reservation with no closing record stays in `openReservations`, and it is never counted as spent.

---

<!-- keryx:reference:begin v=1 hash=dac53455e26ad35f581a121a9bb36d70f75fcd704be48575e52e07ad079f22bc -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `buildGovernanceReport`
- `GOVERNANCE_SCHEMA_VERSION`
- `governanceDataRoot`
- `readLatestGovernanceReport`
- `renderGovernanceMarkdown`
- `formatUsd`
- `writeGovernanceArtifacts`
- `renderEffectLine`
- `renderSummaryLine`
- `readProjectTriggerSpend`
- `BuildGovernanceReportOptions`
- `usd`
- `renderAcceptanceLine`

### Key files

- `src/governance/service.ts` - imported by 15, imports 4
- `src/governance/report.ts` - imported by 5, imports 6
- `src/governance/types.ts` - imported by 7, imports 3
- `src/governance/aggregate.ts` - imported by 1, imports 8
- `src/governance/report.test.ts` - imported by 0, imports 9
- `src/governance/spend.ts` - imported by 4, imports 5

### Depends on

- `src/flow` - 8 import(s)
- `src/lib` - 4 import(s)
- `src/review` - 3 import(s)
- `src/trigger` - 3 import(s)

### Depended on by

- `src/tui` - 8 import(s)
- `src/commands` - 1 import(s)

### Dependency basis

- Production imports only: 20 import(s) from test file(s) (e.g. `src/commands/governance.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 9
- Cross-module imports: 18
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/flow](src-flow.md)
- [Module src/lib](src-lib.md)
- [Module src/review](src-review.md)
- [Module src/trigger](src-trigger.md)
- [Module src/tui](src-tui.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
