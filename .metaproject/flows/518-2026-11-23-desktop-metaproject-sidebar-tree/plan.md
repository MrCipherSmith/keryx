# Plan — tree navigation in the Metaproject sidebar

## Approach

One new read-only v2 action, `tree`, returns the children of one tree node, paged. Desktop asks for the root when the list first shows the tree and for a folder's children when the user expands it. The action is optional: a reader lists it in `capabilities`, and Desktop uses the tree only when the answering CLI offers it. Everything else in the explorer is unchanged.

Rejected: sending the whole tree in `catalog` (4,600 files exceed the catalog's 200-node cap and the 1 MiB response bound on larger repos); building the tree client-side from search results (incomplete and slow).

## Contract (Core, `src/integrations/metaproject-explorer-contract.ts`)

Request:

```ts
{ version: 2; action: "tree"; scope: "graph" | "wiki"; parent?: string; cursor?: string; expectedSnapshotId?: string }
```

- `scope: "graph"` — `parent` absent is the checkout root; otherwise a checkout-relative folder path (`isMetaprojectRelativePath`). Children: the folders directly under `parent` that contain at least one indexed file node (any depth), sorted by name; then the file nodes directly under `parent`, sorted by name. Symbols never appear. A folder whose path equals a module node's path carries that module node.
- `scope: "wiki"` — `parent` absent lists one group per wiki page type present (key = the page type, `other` for pages without one), sorted by display name; `parent` = a group key lists that group's pages sorted by title.
- Exact keys, as every other v2 action; anything else is `invalid-input`. An unknown `parent` is `not-found`. A mismatched `expectedSnapshotId` or a cursor from another snapshot is `stale-snapshot`.

Response:

```ts
interface MetaprojectTreeV2 {
  schemaVersion: 2; snapshotId: string;
  scope: "graph" | "wiki"; parent: string | null;
  entries: MetaprojectTreeEntry[];
  nextCursor?: string;   // more entries of this parent
  partial: boolean;      // the source behind the scope is missing or incomplete
}
type MetaprojectTreeEntry =
  | { type: "folder"; path: string; name: string; files: number; module?: MetaprojectNode }
  | { type: "group"; key: string; name: string; pages: number }
  | { type: "node"; node: MetaprojectNode };
```

Paging: at most `METAPROJECT_PAGE_SIZE_V2` entries and `METAPROJECT_RESPONSE_BYTES_V2` per page, with the existing snapshot-bound cursor helpers. A graph that is not built answers `entries: []`, `partial: true` for `scope: "graph"`; the wiki scope answers from whatever wiki pages the catalog source has. `capabilities` adds `"tree"` to `METAPROJECT_CAPABILITIES`. v1 parsing and responses do not change.

## Transport

- **Rust** (`apps/desktop/src-tauri/src/metaproject.rs`): add `RequestV2::Tree { scope: TreeScope, parent: Option<String>, cursor: Option<String>, expected_snapshot_id }`, validated in `valid_v2` (graph `parent` a `relative_path`, wiki `parent` `valid_text`, cursor `valid_text`). `ACTIONS` — the set a CLI must offer — stays the six existing actions. Rust tests cover accept and refuse cases. Verified in GitHub CI only (no local cargo).
- **Desktop platform** (`apps/desktop/src/platform/metaproject.ts`): request/response types for `tree`, a response guard, and the negotiated capability set exposed to the view (for example `supportsTree`), so the view can tell an older CLI from a newer one. The handshake still requires only the actions Desktop always sends.
- **Dev bridge**: no change expected (it uses `parseExplorerRequest`); confirm with a test or a note.

## Desktop UI

New component `apps/desktop/src/metaproject/MetaprojectTree.tsx` (+ `MetaprojectTree.dom.test.tsx`), mounted inside `nav.metaproject-list` of `MetaprojectView.tsx` when there is no search query, the mode is Graph or Wiki, and the CLI offers `tree`. Otherwise the list renders exactly as today.

- WAI-ARIA tree: `role="tree"` with an accessible name; rows `role="treeitem"` with `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded` on folders/groups, `aria-selected` on the selected node; one roving `tabIndex=0`. Keys: Up/Down move, Right expands or enters the first child, Left collapses or goes to the parent, Enter/Space selects a node row or toggles a folder, Home/End go to the first/last visible row. Data arriving never takes focus from elsewhere; when the focused row itself is replaced (its folder or next page loaded, or its status row removed), focus goes to the row now at its place: an entry row's successor, a status row's first following row of its own parent (operator decision, fix round 1; parent-scoped in fix round 3).
- Rows: folder/group = disclosure chevron, name, count; node row = title and the existing kind label; a module folder row selects the module node on Enter/click on its name and toggles on the chevron.
- Selecting a node row calls the same path a search result uses today (`openHit`/`select`/`openDocument`), so Graph, panel, Wiki and Back behave as they do now.
- Loading: a folder being read shows one "Loading…" row under it; a failed read shows an inline row with the error and a Retry that re-reads only that folder; a `nextCursor` shows a "Show more" row that appends the next page.
- State: expanded folders and loaded children are kept per scope (graph, wiki) in the explorer state that already survives leaving the view (flow 515). A new snapshot drops loaded children, keeps the expanded set, re-reads expanded folders, and silently forgets folders that no longer exist.
- Reveal: when the selection changes from outside the tree (graph click, search result, Back, details panel), the tree expands the selected node's ancestor folders (reading them as needed), scrolls the row into view (`block: "nearest"`) and does not take focus.
- Heading: `Files` in Graph, `Wiki` in Wiki, with the root counts; search keeps `Results · N`.
- Styling uses the existing tokens and list classes of `metaproject.css`; no new colours.

## State × event matrix

| state \ event | expand folder | select node row | selection changes elsewhere | type a search query | clear the query | leave the view and return | new snapshot (refresh/rebuild) | CLI without `tree` |
|---|---|---|---|---|---|---|---|---|
| root loading | — | — | revealed once root arrives (AC6) | flat results replace the tree; the root read's late answer is dropped (AC6) | tree returns | loading continues or re-reads; no duplicate rows (AC6) | read restarts on the new snapshot (AC6) | flat list, no error (AC4) |
| root loaded | folder shows "Loading…", then children (AC5) | node selected exactly as a search result would (AC5) | ancestors expand, row scrolled into view, focus unchanged (AC6) | flat results (AC6) | tree with the same expanded folders (AC6) | same expanded folders and selection (AC6) | children re-read for expanded folders; vanished folders dropped (AC6) | — |
| folder loading | second expand/collapse does not issue a second read (AC5) | — | reveal waits for it | late answer dropped from view, kept for the cache only if same snapshot | — | — | late answer for the old snapshot dropped (AC6) | — |
| folder read failed | Retry re-reads that folder only; other folders unaffected (AC5) | — | reveal stops at the failed folder, no loop (AC6) | — | error row still shown | error row still shown | re-read on the new snapshot | — |
| folder or page read answered stale-snapshot | parked: the row stays "Loading…", no Retry; the Refresh catalog banner shows (operator decision) | — | reveal waits on the parked folder | — | parked row still shown | parked row still shown | every catalog load re-reads parked reads, same snapshot id included (fix round 3); a new snapshot drops them | — |
| more pages | "Show more" appends the next page in order, no duplicates (AC5) | — | reveal pages until the row is found or pages end (AC6) | — | — | loaded pages kept | cursor from old snapshot never sent (AC6) | — |
| graph not built (`partial`, empty) | — | — | — | flat results | existing "graph is not built" state stays; tree shows an empty-state line (AC5) | — | tree appears after rebuild (AC6) | — |

## Verification

Core contract and service tests, Desktop platform tests, tree component and view tests, the full Desktop suite with `tsc`, core typecheck and lint, the Rust tests in GitHub CI, docs check, then the managed review. Every check is a task (tasks.md). The native walkthrough is outside the criteria by operator decision; it joins the pending native check of flows 512 and 514.
