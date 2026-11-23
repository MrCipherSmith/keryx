# Desktop Metaproject: readable neighbourhood graph, node summary panel and explorer navigation fixes

Status: formalized
Source: user description (owner's review request of 2026-11-23, then "start with the graph and the details panel")

## Problem

The Metaproject screen of Keryx Desktop (`apps/desktop/src/metaproject/`) does not let a
developer read what a project object is connected to. A review of the shipped screen on this
repository (4,659 files, 200 modules, 125 wiki pages) measured, in the browser dev build:

- **The graph is unreadable.** At the default 1180×780 window the canvas gets 440×194 px (9% of
  the window). Every neighbour sits on one ring regardless of direction and depth, as an identical
  grey circle; labels render at 3.3–5.5 px; edge kinds are passed to cytoscape but never drawn;
  there is no legend. At depth 2 the ring is 200 nodes spaced 2.6 px apart with a 13.6 px diameter.
- **The node details panel says nothing about the node.** It is 380 px wide and holds only a
  Wiki / OpenSpec document lookup. Its text uses three sizes (12/13/15 px) and two colours; section
  heading and body are the same size; every button looks the same; the previews show raw Markdown
  (`> **Covers:** …`).
- **Navigation and state are fragile.** Leaving the work view destroys mode, query, selection and
  Back history. Back ignores hops between graph nodes. "Find a Wiki page" lands on "No results"
  next to an unrelated article. Graph filters silently change the Relationships block in Wiki
  (13 → 350 relationships). "Rebuilding…" can stick. A failed protocol negotiation leaves
  "Loading project knowledge…" forever. Wiki links to pages outside the loaded 200 nodes do
  nothing.

The owner's stated complaints: the graph is not understandable, and in the node details
everything visually merges. (The third complaint, a tree instead of the flat sidebar list, needs a
new backend action and is a separate piece of work.)

## Expected Outcome

- The graph is a readable local neighbourhood: incoming neighbours left of the selected node,
  outgoing right, second-step nodes further out; node kind and relationship kind are visible on the
  canvas and explained by a legend; labels are legible at the default window size; an over-full side
  is capped with a "+N more" entry instead of overlapping.
- The node details panel is a summary of the node: identity, path with copy, relationship counts,
  the relationships themselves grouped by direction and kind, then linked documents — with a visible
  hierarchy built from the app's existing tokens and patterns.
- Explorer state survives leaving the work view; Back steps through in-view navigation; the Find,
  Rebuild, negotiation and wiki-link dead ends are gone; Wiki relationships no longer depend on Graph
  filter state.

## Outcome criteria

- On the default 1180×780 window, a module with 30 or more neighbours is readable in the graph
  without zooming: rendered label size is at least 9 px (it was 3.3–5.5 px), measured in the browser
  dev build before and after.

## Out of Scope

- The sidebar tree (needs a new explorer action and a relaxed capability handshake).
- Any change to the explorer contract, the CLI, the Rust core or the dev bridge:
  `src/integrations/**`, `apps/desktop/src-tauri/**`, `apps/desktop/dev/**`,
  `apps/desktop/src/platform/metaproject.ts`. A parallel session is fixing the backend defects there
  (unstable v2 snapshot id, per-request staleness check, exact-match capability handshake).
- Per-request latency (about 0.8 s per read) and read cancellation or queueing.
- A redesign of the OpenSpec view.
- Actions on a found object beyond "Copy path" (open in Files, send to a session, start a flow).
- New screenshots for `docs/docs/images/desktop-metaproject/` (they need a native capture).
- New dependencies: the graph stays on core `cytoscape`.
