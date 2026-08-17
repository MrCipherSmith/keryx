# Implementation Plan

## Approach

Compose existing TUI pieces. Do not invent a second overlay.

1. Pure session store (`src/tui/subagent-session.ts`) holds every spawned
   child for the TUI lifetime: status, model, task, startedAt, and an append-only
   work log. No 15s auto-remove.
2. Bridge grows a `log` event; `spawn_subagent` emits task / tool / text /
   reasoning / system into it. Child privilege invariants stay unchanged.
3. Sidebar Status keeps the main-agent headline. Below it, a **Subagents N**
   list paints one `TextRenderable` per child with `onMouseDown` — no truncation.
4. Click calls `presentSubagentInspector` → `openModal` (Work + Meta tabs),
   subscribed to the store so a running child updates live.

Rejected: Grok-style fullscreen takeover (we already have a modal host);
SelectRenderable in the sidebar (steals composer focus).

## Steps

1. RED: session store + formatter tests; inspector `openModal` shape tests.
2. GREEN: store, inspector, bridge `log` event, spawn IO wiring, tui-shell list.
3. Keep `formatFleetSidebar` for the main Status block; do not reuse it for
   the clickable list.

## Risks

- Sidebar height: many children must scroll, not clip the toast. Use a
  flexGrow list box, not `alignSelf` on a transcript-like child.
- Streaming `write` vs `onAssistantText`: log finalized text + tool names;
  do not duplicate every token as its own event.
- `remove` events: ignore for `sub:*` so the inspector still opens after done.
