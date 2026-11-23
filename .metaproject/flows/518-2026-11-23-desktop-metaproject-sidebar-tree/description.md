# Desktop Metaproject: tree navigation in the sidebar

Status: formalized
Source: owner request of 2026-11-24 ("look at what is next in the plan, start a flow in a new worktree and implement the next stage"). The tree is the third complaint of the owner's 2026-11-23 review of the Metaproject screen; flow 515 deferred it because it needs a new explorer action and a relaxed capability handshake ([515 description](../515-2026-11-23-desktop-metaproject-graph-panel/description.md), Out of Scope).

## Problem

The left list of the Metaproject screen (`apps/desktop/src/metaproject/MetaprojectView.tsx`, `nav.metaproject-list`) shows, without a search, a flat list of the catalog's first nodes. The catalog is capped at 200 nodes (`METAPROJECT_NODE_LIMIT`), while this repository indexes about 4,600 files, 200 modules and 125 wiki pages. So:

- most of the project cannot be reached from the list without typing a search;
- the list has no structure: files, modules and wiki pages of every folder are mixed in one column, so the user cannot browse "what is in `src/flow`";
- the Wiki view lists pages without the grouping the wiki itself uses (architecture, components, business rules, …).

## Expected Outcome

- Without a search query, the list is a tree. In **Graph** it mirrors the indexed files by folder: folders first, then files, each folder with the number of indexed files under it; a folder that is a module can be selected as that module's graph node. In **Wiki** pages are grouped by page type.
- Folders load their children on demand from a new paged Core action, so the whole project is reachable however large it is.
- The tree is keyboard-operable as a WAI-ARIA tree, keeps its expanded folders when the user leaves the explorer and comes back, and reveals the selected node when the selection changes elsewhere (graph click, search result, Back).
- With a search query the list stays the current flat result list.
- A Desktop talking to an older CLI that does not offer the tree action keeps today's flat list, with no error.

## Outcome criteria

- On this repository, every indexed file is reachable from the Graph list without typing a search: the root lists the top-level folders, and expanding them leads to any file (measured by the tree contract tests over a fixture, and by the operator on this checkout).

## Out of Scope

- Changing what the graph, the details panel or the OpenSpec view show (flows 515 and 514 own them).
- Read latency and cancellation of explorer reads (about 0.8 s per read; a separate stage).
- Actions on a tree row beyond selecting it (open in Files, send to a session, start a flow).
- Drag and drop, renaming, or any write to the project.
- Native screenshots for the guide.
- New dependencies.
