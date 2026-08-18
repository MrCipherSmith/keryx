// Pure keyboard queue-nav stepper helpers (flow 170 T5).
//
// Kept OUT of `main-queue.ts` on purpose: that module's own header commits it
// to staying a pure, unit-tested, REUSED-VERBATIM layer (no signature/behavior
// changes per the TRD's NFR-1) — this file holds only the new queue-nav
// keyboard mode's index/action arithmetic, unit-testable without mounting a
// renderer, the same "pure extraction" idea `main-queue.ts` already
// established for the mouse/text-command paths.

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
