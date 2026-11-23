# Implementation Plan

Status: formalized (orchestrator, 2026-11-23)

## Approach

Frontend-only change inside `apps/desktop/src/metaproject/` plus one mount change in
`apps/desktop/src/App.tsx`. The explorer contract, the CLI, the Rust core and the dev bridge stay
as they are; the graph stays on core `cytoscape` (no new dependency).

The work is cut so that three implementers can run at once on disjoint files, followed by one
integration task:

1. **Wave 1, in parallel** — T5 and T6 only add new files; T7 edits existing ones. Nothing in
   wave 1 changes a file another wave-1 task owns, and the tree type-checks after each of them.
2. **Wave 2** — T8 swaps the new graph and panel into the explorer, removes the code they replace,
   and tidies the layout.
3. **Then** — T9 (guide), T10 (full checks), T11 (live browser verification by the orchestrator),
   T4 (review round).

Rejected alternatives:

- *One implementer, one task.* Smallest coordination cost, but a 920-line file rewritten in one
  dispatch has no verification point until the end.
- *`cose` / `breadthfirst` / `concentric` layouts of core cytoscape.* None can put incoming
  neighbours on one side and outgoing on the other; `concentric` is today's ring with a second
  radius. A computed `preset` layout is deterministic and unit-testable.
- *`cytoscape-dagre`.* Would layer depth-2 paths with crossing minimisation, but adds a dependency
  for a depth of at most two.
- *Lifting explorer state into a store to survive unmount.* More code than keeping the view mounted
  after its first visit, which is how the session view already behaves.

## Design direction

There is no `DESIGN.md` in the repository. This section is the direction for this flow; it is
derived from the app's existing tokens and screens and introduces no new visual language.

- **Tokens only.** Colours, spacing, type sizes and radii come from
  `apps/desktop/src/styles/tokens.css` and work in every palette of `themes.css`. No raw colour
  values in components or CSS; cytoscape gets its colours by resolving tokens at runtime.
- **Type.** Three sizes in the panel: `--fs-lg` (title), `--fs-md` (body, rows), `--fs-sm` (meta,
  section headings). Section headings are `--fs-sm`, weight 650, `--fg-muted`. Paths are monospace.
- **One primary action per surface.** Other actions are quiet (`.btn-ghost` or icon buttons).
- **Meaning is never colour alone.** Node kinds differ by shape or border style and are named in a
  legend; relationship kinds are named in group captions and differ by line style.
- **Reuse.** `.info-panel` / `.info-section` / `.info-row`, `.badge`, `.chip-btn`, `.tabs` / `.tab`
  with `.tab-count`, `.section-title`, `.activity-row`, `EmptyState`, `Spinner`, `.side-resize`,
  `Icon`. A new class is added only where none of these fits, and lives in the task's own CSS file.
- **States.** Every data area has loading, empty (specific reason and an action), error (cause and
  Retry) and limited (says what is hidden) states. Focus rings stay visible; targets are at least
  24×24 px; motion respects `prefers-reduced-motion`.

### Graph: a local neighbourhood in columns

Layout is computed by a pure function and handed to cytoscape as `preset` positions.

- Columns, left to right: second-step incoming · incoming · **root** · outgoing · second-step
  outgoing. A neighbour whose only edges with the root point at the root is *incoming*; one the root
  points at is *outgoing*; one with both is placed with outgoing. A second-step node goes to the
  outer column on the side of the first-step node it is attached to.
- Inside a column nodes are grouped by relationship kind (in the order of
  `METAPROJECT_EDGE_KINDS_V2`), then sorted by title. Each group has a caption such as
  "imports · 15".
- A column shows at most 12 nodes; the rest collapse into one "+N more" entry at the bottom of the
  column. Hidden neighbours stay reachable in the panel's relationship list.
- Nodes are rounded rectangles with the label inside, 24 px high, width from the label, at most
  about 132 px (root up to 180 px); long labels are shortened in the middle so a file extension
  survives. Column gap about 44 px, row pitch about 30 px. These numbers may be tuned as long as the
  acceptance criteria hold.
- Node kind → shape and tint: module (thicker `--fg-muted` border), file (plain), symbol (barrel),
  wiki (cut rectangle, `--info`), spec and change (tag shape, `--ok` / `--warn`), archive (tag shape,
  dashed border). The root keeps its kind's shape with an `--accent` border and `--bg-selected` fill.
- Relationship kind → line style: solid for `imports`, `calls`, `asset`; dashed for `describes`,
  `links`, `changes-spec`, `spec-context`; dotted for `contains`, `defines`. Module imports with a
  `count` are thicker. Second-step edges are fainter.
- Zoom: fit, but never automatically below 0.8 (12 px labels stay ≥ 9.6 px) or above 1.15. When the
  layout is wider than the box at 0.8, centre on the root and let the user pan. Wheel zoom and three
  overlay buttons (zoom in, zoom out, fit) are available; nodes are not draggable.
- Overlay (HTML, not canvas): a caption "<root title> · N incoming · M outgoing" (plus "limited"
  when the projection is truncated) and a legend listing only the node kinds and line styles present.
- Interaction: tap a node selects it; tap "+N more" asks the host to reveal the relationship list;
  hover highlights a node with its edges and fades the rest.
- Lifecycle: one cytoscape instance per mount; a new projection replaces elements in a batch; the
  select callback is read through a ref; colours are re-resolved when `data-theme` or
  `data-palette` changes on the document element; label size follows `--text-scale`.
- The canvas stays `aria-hidden`; the keyboard and screen-reader path is the relationship list.

### Panel: a summary of the node

- Header: kind badge with icon, close button; title; path in monospace with a "Copy path" control.
- Facts (`.info-row`): module (files), page type and status (wiki, as a badge), line (symbols),
  relationship counts "N incoming · M outgoing" from the current projection, with "limited" when it
  is truncated.
- One tab bar with counts: **Relationships** · **Wiki** · **OpenSpec**. Relationships is the default.
- Relationships: adjacent relationships grouped by direction, then by kind; a row is the other
  node's title, a kind badge and its path, and selects that node. Second-step relationships are a
  separate group where each row names both ends and can open either. Evidence is shown as at most
  two example lines; digests are not shown.
- Wiki / OpenSpec: today's behaviour (linked documents, suggested component page, preview, Open,
  Find, Draft), with a preview cleaned of Markdown markers and of the "Covers:" metadata line.
- Docked on wide hosts with a resize handle; on a host narrower than 820 px it is a right-anchored
  drawer that leaves part of the content visible, takes focus on open and returns it on close.
  Docked, it does not move focus when it opens.

## File ownership

| Task | May create or edit | Must not edit |
|---|---|---|
| T5 graph | new: `graphLayout.ts`, `graphLayout.test.ts`, `RelationshipGraph.tsx`, `RelationshipGraph.dom.test.tsx`, `graph.css` (all in `apps/desktop/src/metaproject/`) | every existing file |
| T6 panel | new: `NodeDetailsPanel.tsx`, `NodeDetailsPanel.dom.test.tsx`, `RelationshipList.tsx`, `RelationshipList.dom.test.tsx`, `nodePanel.css` (all in `apps/desktop/src/metaproject/`) | every existing file |
| T7 navigation | `MetaprojectView.tsx` (not the `Graph` and `RelationshipList` components, not the `<GraphNodePanel>` element), `useExplorerNavigation.ts`, `MetaprojectView.dom.test.tsx`, `apps/desktop/src/App.tsx` | T5 and T6 files, `GraphNodePanel.tsx`, `metaproject.css` |
| T8 integration | `MetaprojectView.tsx`, `metaproject.css`, `MetaprojectView.dom.test.tsx`, `OpenSpecView.tsx` (imports only), delete `GraphNodePanel.tsx`; T5/T6 files only to fix an integration defect | — |
| T9 guide | `docs/docs/guides/desktop-metaproject.md` | code |

Nobody edits `src/integrations/**`, `apps/desktop/src-tauri/**`, `apps/desktop/dev/**` or
`apps/desktop/src/platform/metaproject.ts`.

## Interfaces between tasks

T8 integrates against exactly these exports. T5 and T6 may add optional props; they may not rename
or drop these.

```tsx
// apps/desktop/src/metaproject/RelationshipGraph.tsx  (T5)
export function RelationshipGraph(props: {
  projection: MetaprojectNeighbors;                 // root = the selected node
  busy?: boolean;                                    // a newer projection is loading: keep rendering, mark aria-busy, dim
  onSelect: (id: string) => void;                    // a node was tapped
  onShowHidden?: (side: "incoming" | "outgoing") => void; // a "+N more" entry was tapped
}): JSX.Element;

// apps/desktop/src/metaproject/RelationshipList.tsx  (T6) — same name and props as today's export in MetaprojectView.tsx
export function RelationshipList(props: {
  projection: MetaprojectNeighbors;
  select: (id: string) => void;
}): JSX.Element;

// apps/desktop/src/metaproject/NodeDetailsPanel.tsx  (T6)
export const isOpenSpecNode: (node: MetaprojectNode) => boolean;
export function NodeDetailsPanel(props: {
  node: MetaprojectNode;
  relationships: MetaprojectNeighbors | null;        // filtered neighbourhood of `node`; null while loading or after a failure
  relationshipsPending: boolean;
  relationshipsProblem: string;                      // "" when none
  revealRelationships?: number;                      // when this number changes: show the Relationships tab and scroll it into view
  documents: MetaprojectNeighbors | null;            // linked-document neighbourhood (today's `projection` prop)
  documentsPending: boolean;                         // today's `pending`
  documentsProblem: string;                          // today's `problem`
  suggestedWiki?: MetaprojectNode;
  openSpec: boolean;                                 // the CLI supports OpenSpec
  readPreview: (id: string) => Promise<MetaprojectDetail>;
  width?: number;
  onResize: (width: number) => void;
  onClose: () => void;
  onSelect: (id: string) => void;                    // select a neighbour in the graph
  onOpen: (node: MetaprojectNode) => void;           // open a document in Wiki / OpenSpec
  onFind: (tab: "wiki" | "openspec") => void;
  onDraft?: (task: string) => Promise<void>;
  onRetry: () => void;
}): JSX.Element;
```

## State × event matrix

Rows are states the explorer can be in; columns are the events this change reaches. A cell says
what the user sees and which state survives. "—" means the event cannot happen in that state;
"no change" means today's behaviour is kept.

| state \ event | select a node (list, graph, panel row) | change a Graph filter | switch view (Graph / Wiki / OpenSpec) | leave the work view and return | Back | Retry / Refresh | theme or palette change | rebuild finishes |
|---|---|---|---|---|---|---|---|---|
| negotiating the protocol | — | — | no change | still negotiating; result applied on arrival (AC10) | — | — | no change | — |
| negotiation failed | — | — | banner stays | banner and Retry still there (AC10) | — | re-negotiates; banner stays until success; no "Loading…" next to the error (AC15) | no change | — |
| catalog loaded, nothing loading | new selection is a history entry (AC11); the list row is selected and scrolled into view (AC17) | relationships re-read with the new filters; not a history entry | each view keeps its own query and selection (no change) | mode, query, selection, filters, panel state and history are as they were (AC10) | previous selection, panel state and scroll restored (AC11) | no change | graph re-coloured in place, no selection change needed (AC6) | — |
| relationships loading for a new selection | the newest selection wins; stale responses are dropped (no change) | same | Wiki's relationships use fixed defaults, never Graph's filters (AC13) | load continues, result applied on arrival (AC10) | previous route; stale response dropped | no change | no change | — |
| … while a previous graph exists | previous graph stays rendered, marked busy, until the new one arrives (AC17) | same | — | — | same | — | — | — |
| relationships failed | no change (error does not follow to the new selection) | re-read | no change | error still shown | no change | no change | — | — |
| projection limited (truncated) | no change | no change | no change | no change | no change | no change | no change | — |
| … column over the cap | "+N more" reveals the relationship list in the panel (AC2, AC8) | — | — | — | — | — | — | — |
| snapshot mismatch | no change | no change | no change | banner still shown | no change | catalog re-read (no change) | — | — |
| rebuilding the graph | allowed; rebuild continues | allowed | allowed | rebuild continues; button state correct on return | allowed | allowed; the rebuild's end still re-enables the button and re-reads the catalog (AC14) | — | button enabled again and catalog re-read, whatever reloaded meanwhile (AC14) |
| Wiki with a query and no hits | — | no effect on Wiki (AC13) | no change | as left | previous route | — | — | — |
| … arrived through "Find a Wiki page" | — | — | — | — | returns to the graph node | — | — | — |
| … what the article area shows | an empty state naming the query, never an unrelated article (AC12) | | | | | | | |
| typing in the search field | — | — | — | query kept | query edits are not history entries (AC11) | — | — | — |
| Wiki article open, link clicked | target not loaded → one lookup read, then open; unresolved → inline message naming the path (AC16) | — | — | — | returns to the article | — | — | — |

## Steps

1. T5 — graph layout module and `RelationshipGraph` (new files).
2. T6 — `NodeDetailsPanel` and `RelationshipList` (new files).
3. T7 — navigation and state fixes D1–D7 in the explorer, the navigation hook and `App.tsx`.
4. T8 — integrate T5 and T6 into the explorer; move the relationship list into the panel; compact,
   labelled filters; counts in the list header; keep the previous graph while loading; delete the
   replaced code and styles.
5. T9 — update the Desktop Metaproject guide.
6. T10 — desktop typecheck and the full desktop test suite.
7. T11 — live browser verification (dev build) at 1180×780, 1440×900 and 720×480, dark and light.
8. T4 — review round, fix rounds as needed.

## Risks

- **cytoscape under happy-dom.** The existing tests never mount the canvas. T5 keeps layout and
  style mapping in pure, tested functions and keeps caption and legend in HTML; if cytoscape cannot
  mount in happy-dom the component test injects a stand-in for the cytoscape factory and says so.
- **Visual tuning without a browser.** Implementers verify with tests and the type checker; the
  orchestrator verifies the render in T11. A fix round after T11 is expected and budgeted.
- **Three lanes in one worktree.** Disjoint file ownership (table above), no `git stash`, no
  `git add -A`, commits only by the orchestrator at task boundaries with explicit paths. A lane
  that sees type errors in another lane's in-progress files reports them and does not touch them.
- **`MetaprojectView.tsx` is edited by T7 and then T8.** They run one after the other.
- **Parallel backend session** edits `apps/desktop/src/platform/metaproject.ts`; this flow does not.
- **Keeping the view mounted** keeps its effects alive while hidden; the graph must tolerate a
  zero-size container (it already guards `fit` on size).
