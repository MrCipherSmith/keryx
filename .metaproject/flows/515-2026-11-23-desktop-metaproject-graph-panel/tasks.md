# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`. The table follows `flow.json`: T12–T16 were added
while the screen was tuned on a live preview, T17–T21 after review round 1; the journal records why.

| ID | Kind | Title | Depends on | Criteria |
|----|------|-------|------------|----------|
| T1 | context | Collect remaining context | — | — |
| T2 | implement | Implement per plan (scaffold; superseded by T5–T8) | — | — |
| T3 | test | Add/adjust tests and make them pass (scaffold; tests live in T5–T8, suite in T10) | — | — |
| T4 | review | Review round on the integrated change | T8, T9, T10, T11, T14, T15, T16, T17, T18, T19, T20, T21 | — |
| T5 | implement | Graph layout module and RelationshipGraph component (new files) | — | AC1, AC2, AC3, AC4 |
| T6 | implement | NodeDetailsPanel and RelationshipList components (new files) | — | AC7, AC8, AC9 |
| T7 | implement | Explorer navigation and state fixes D1–D7 | — | AC11, AC12, AC13, AC14, AC15, AC16 (and the code for AC10) |
| T8 | implement | Integrate graph and panel into the explorer; filters, counts, cleanup | T5, T6, T7, T12, T13 | AC17, AC18, AC19 (and the code for AC5, AC6, AC20) |
| T9 | docs | Update the Desktop Metaproject guide | T12, T13 | AC21 |
| T10 | verify | Desktop typecheck and full desktop test suite pass | T8 | AC19 |
| T11 | verify | Live browser verification at three window sizes, dark and light | T8, T14 | AC5, AC6, AC10, AC20 |
| T12 | implement | Graph polish from the isolated live preview | T5 | AC1, AC2, AC3, AC4 |
| T13 | implement | Panel and relationship list polish from the isolated live preview | T6 | AC7, AC8, AC9 |
| T14 | implement | Compact filter bar and one-row header on narrow hosts (became the Filters popover) | T8 | AC17, AC19, AC20 |
| T15 | docs | Align the guide with the final screen and refresh its screenshots | T14 | AC21 |
| T16 | implement | One-line freshness banner with details on demand | T14 | AC19, AC20 |
| T17 | implement | Fix round 1: explorer behaviour (F-001, F-003, F-004, F-005, F-006, F-008) | — | AC10, AC11, AC14, AC16, AC17, AC19, AC20 |
| T18 | implement | Fix round 1: details panel and relationship list (F-007, F-019, F-020, F-022) | — | AC7, AC8, AC9, AC19 |
| T19 | test | Fix round 1: graph test strength (F-012, F-013, F-021) | — | AC1, AC2, AC3, AC4, AC6, AC19 |
| T20 | test | Fix round 1: explorer test strength (F-011, F-014, F-015, F-016, F-017, F-018) | T17 | AC10, AC11, AC12, AC13, AC16, AC17, AC19 |
| T21 | docs | Fix round 1: flow record and guide (F-009, F-010, guide alignment with the fixes) | T17, T18 | AC21 |

## Context

- **T1.** Done by the review that preceded this flow; its findings are in `context.md`,
  "Agent Findings".

## Implement

- **T5 — graph (wave 1).** New files only, in `apps/desktop/src/metaproject/`: `graphLayout.ts`
  (pure `layoutNeighborhood`), `graphLayout.test.ts`, `RelationshipGraph.tsx`,
  `RelationshipGraph.dom.test.tsx`, `graph.css`. Design: `plan.md`, "Graph: a local neighbourhood in
  columns". Export contract: `plan.md`, "Interfaces between tasks".
- **T6 — panel (wave 1).** New files only, in `apps/desktop/src/metaproject/`:
  `NodeDetailsPanel.tsx`, `NodeDetailsPanel.dom.test.tsx`, `RelationshipList.tsx`,
  `RelationshipList.dom.test.tsx`, `nodePanel.css`. Design: `plan.md`, "Panel: a summary of the
  node". The behaviour of the Wiki / OpenSpec document tabs is carried over from
  `GraphNodePanel.tsx`, which stays untouched until T8.
- **T7 — navigation and state (wave 1).** Defects D1–D7 of `context.md` in `MetaprojectView.tsx`
  (outside the `Graph`, `RelationshipList` and `<GraphNodePanel>` parts), `useExplorerNavigation.ts`
  and `apps/desktop/src/App.tsx`, with tests in `MetaprojectView.dom.test.tsx`. Behaviour per cell:
  `plan.md`, "State × event matrix".
- **T8 — integration (wave 2).** Replace the inline `Graph` with `RelationshipGraph` and
  `GraphNodePanel` with `NodeDetailsPanel`; import `RelationshipList` from its own file; render the
  relationship list in the panel and no longer under the canvas; give the graph the freed height;
  human-readable filter labels, `defines` / `calls` disabled without a symbol layer; "shown of total"
  in the list header instead of the "Catalog is limited" banner; scroll the selected row into view;
  keep the previous graph, marked busy, while a new selection loads; wire `onShowHidden` to
  `revealRelationships`; show explorer banners above the OpenSpec view; delete `GraphNodePanel.tsx`,
  the replaced CSS and the dead `@media (max-width: 700px)` block; update the tests.

## Docs

- **T9.** `docs/docs/guides/desktop-metaproject.md`: "Trace relationships in Graph", the Wiki
  section and the opening paragraph, to match what ships. Screenshots are out of scope.

## Verify

- **T10.** `cd apps/desktop && bunx tsc --noEmit && bun test src` on the integrated head.
- **T11.** The orchestrator opens the browser dev build on this repository and checks AC5, AC6,
  AC10 and AC20, recording the measured values in `journal.md`.

## Polish and follow-up tasks (added after the first plan)

- **T12 — graph polish.** Changes the orchestrator asked for after seeing the graph on an isolated
  live preview; dispatch `dispatch/T12.dispatch.json`.
- **T13 — panel and list polish.** The same for the details panel and the relationship list;
  dispatch `dispatch/T13.dispatch.json`.
- **T14 — filters.** Started as a compact filter bar; on the operator's request it became a "Filters"
  button that opens a popover; dispatch `dispatch/T14.dispatch.json`.
- **T15 — guide alignment.** The guide brought in line with the final screen, with the two
  screenshots replaced; dispatch `dispatch/T15.dispatch.json`.
- **T16 — freshness banner.** One line with "Details" on demand; dispatch `dispatch/T16.dispatch.json`.

## Review

- **T4.** `review-orchestrator` on the flow's diff, with fix rounds through `task-implementer`.
  Round 1: package `.metaproject/reviews/2026-11-23-review-flow-branch` (29 findings: 2 major,
  20 minor, 7 info).

## Fix round 1 (findings of review round 1)

Each task's finish line is in its dispatch file; the findings are in the review package's
`findings.json`. Info findings are not fixed; they are listed in the completion report.

- **T17 — explorer behaviour.** F-001 (the Filters popover runs past a 720×480 window), F-003 (its
  Escape layer outlives the visible view), F-004 (re-read the catalog on return, upheld by the
  operator), F-005 (Wiki-link lookups settled by arrival order), F-006 (a catalog walk on every
  render), F-008 (Back in OpenSpec lands at the top, upheld by the operator).
- **T18 — details panel and relationship list.** F-007 (the fact row also shows the second-step
  count, the operator's choice), F-022 (a self-loop counted in the panel and skipped in the graph
  caption), F-019 and F-020 (surviving mutants of the panel and the list).
- **T19 — graph test strength.** F-012, F-013, F-021: 22 surviving mutants of `graphLayout.ts` and
  `RelationshipGraph.tsx`.
- **T20 — explorer test strength.** F-011, F-014 to F-018: 26 surviving mutants of
  `MetaprojectView.tsx`, `useExplorerNavigation.ts` and `App.tsx`; after T17, which edits the same files.
- **T21 — flow record and guide.** F-009 (this file), F-010 (the resolved-context and result files the
  T9 and T15 dispatches name), and the guide where T17 and T18 change what it describes.
