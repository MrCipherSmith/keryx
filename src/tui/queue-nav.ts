// Pure keyboard row-nav stepper helpers: queue-nav (flow 170 T5) and, beside
// it, connect-nav (flow 304).
//
// Kept OUT of `main-queue.ts` on purpose: that module's own header commits it
// to staying a pure, unit-tested, REUSED-VERBATIM layer (no signature/behavior
// changes per the TRD's NFR-1) — this file holds only the new queue-nav
// keyboard mode's index/action arithmetic, unit-testable without mounting a
// renderer, the same "pure extraction" idea `main-queue.ts` already
// established for the mouse/text-command paths.
//
// `/connect`'s row-list step (flow 304, AC3) reuses `stepQueueNavIndex`/
// `clampQueueNavIndex` verbatim for its own up/down row movement — neither is
// queue-specific, both are already generic over "how many rows". Only the
// per-row ACTION set differs (Label/Test/Disconnect vs. Force/Edit/Delete),
// so connect-nav gets its own three-state action type and stepper below,
// following `stepQueueNavAction`'s exact shape.

/** The three per-item actions queue-nav mode cycles ←/→ through. */
export type QueueNavAction = "force" | "edit" | "delete";

const QUEUE_NAV_ACTIONS: readonly QueueNavAction[] = ["force", "edit", "delete"];

/**
 * Move `selected` (0-based) up/down through `count` items, wrapping at both
 * ends. `count <= 0` always returns 0 — there is nothing to select.
 */
export function stepQueueNavIndex(selected: number, count: number, direction: "up" | "down"): number {
  if (count <= 0) return 0;
  if (direction === "up") {
    return selected > 0 ? selected - 1 : count - 1;
  }
  return selected < count - 1 ? selected + 1 : 0;
}

/**
 * Clamp `selected` into `[0, count - 1]` (or 0 when `count <= 0`) — used
 * after the queue mutates (an item ahead of the current selection is
 * force/edit/deleted out from under it) so the highlight never points past
 * the new end.
 */
export function clampQueueNavIndex(selected: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(selected, 0), count - 1);
}

/** Move the highlighted action left/right through Force → Edit → Delete, wrapping. */
export function stepQueueNavAction(selected: QueueNavAction, direction: "left" | "right"): QueueNavAction {
  const idx = QUEUE_NAV_ACTIONS.indexOf(selected);
  const count = QUEUE_NAV_ACTIONS.length;
  const nextIdx = direction === "left" ? (idx > 0 ? idx - 1 : count - 1) : idx < count - 1 ? idx + 1 : 0;
  return QUEUE_NAV_ACTIONS[nextIdx]!;
}

/**
 * The three per-row targets `/connect`'s row-nav mode cycles ←/→ through
 * (flow 304, AC3). `"label"` is the default/leftmost — Enter on it selects
 * the provider, exactly as Enter/a label click does today — `"test"` and
 * `"disconnect"` fire the row's two buttons.
 */
export type ConnectNavAction = "label" | "test" | "disconnect";

const CONNECT_NAV_ACTIONS: readonly ConnectNavAction[] = ["label", "test", "disconnect"];

/** Move the highlighted column left/right through Label → Test → Disconnect, wrapping. Mirrors {@link stepQueueNavAction}. */
export function stepConnectNavAction(selected: ConnectNavAction, direction: "left" | "right"): ConnectNavAction {
  const idx = CONNECT_NAV_ACTIONS.indexOf(selected);
  const count = CONNECT_NAV_ACTIONS.length;
  const nextIdx = direction === "left" ? (idx > 0 ? idx - 1 : count - 1) : idx < count - 1 ? idx + 1 : 0;
  return CONNECT_NAV_ACTIONS[nextIdx]!;
}
