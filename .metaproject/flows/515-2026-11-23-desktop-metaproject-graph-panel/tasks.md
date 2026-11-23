# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title | Depends on | Criteria |
|----|------|-------|------------|----------|
| T1 | context | Collect remaining context | — | — |
| T2 | implement | Implement per plan (scaffold; superseded by T5–T8) | — | — |
| T3 | test | Add/adjust tests and make them pass (scaffold; tests live in T5–T8, suite in T10) | — | — |
| T4 | review | Review round on the integrated change | T8, T9, T10, T11 | — |
| T5 | implement | Graph layout module and RelationshipGraph component (new files) | — | AC1, AC2, AC3, AC4 |
| T6 | implement | NodeDetailsPanel and RelationshipList components (new files) | — | AC7, AC8, AC9 |
| T7 | implement | Explorer navigation and state fixes D1–D7 | — | AC11, AC12, AC13, AC14, AC15, AC16 (and the code for AC10) |
| T8 | implement | Integrate graph and panel into the explorer; filters, counts, cleanup | T5, T6, T7 | AC17, AC18, AC19 (and the code for AC5, AC6, AC20) |
| T9 | docs | Update the Desktop Metaproject guide | T8 | AC21 |
| T10 | verify | Desktop typecheck and full desktop test suite pass | T8 | AC19 |
| T11 | verify | Live browser verification at three window sizes, dark and light | T8 | AC5, AC6, AC10, AC20 |

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

## Review

- **T4.** `review-orchestrator` on the flow's diff, with fix rounds through `task-implementer`.
