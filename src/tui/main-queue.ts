// Pure main-queue helpers for the TUI busy-input router (flow 167).
//
// The interactive shell keeps `mainQueue` state + rendering inside
// `launchTuiAgentShell` (src/tui/tui-shell.ts); this module holds the PURE,
// unit-testable part — marker formatting and the remove/edit/reinsert
// moves — so the queue behaviour is pinned by tests without mounting a whole
// renderer. No OpenTUI / no renderer dependency; frame colouring of the
// transcript marker stays in tui-shell.ts.
//
// A queued main item is a stable record with its own `id` (the renderable
// box id is derived from it) so remove/renumber can target the right entry
// and the `qN` counter can reflow after any mutation.

export interface QueuedMainQuestion {
  id: string;
  question: string;
  displayQuestion: string;
}

export type QueueCommandAction = "remove" | "edit" | "force";

export interface ParsedQueueCommand {
  action: QueueCommandAction;
  /** 1-based `qN` position; defaults to 1 (the head) when omitted. */
  position: number;
}

/**
 * Parse the argument tail of `/queue <remove|edit|force> [N]` — the `/queue`
 * token itself is already consumed by the caller. `undefined` for an
 * unrecognized action or a non-positive/non-integer position, so the caller
 * can show a usage message instead of silently no-op'ing.
 */
export function parseQueueCommand(args: string): ParsedQueueCommand | undefined {
  const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
  const action = parts[0]?.toLowerCase();
  if (action !== "remove" && action !== "edit" && action !== "force") {
    return undefined;
  }
  const raw = parts[1];
  if (raw === undefined) {
    return { action, position: 1 };
  }
  // Strict digits-only check: `Number.parseInt` would silently accept "1.5"
  // or "1abc" by truncating at the first non-digit.
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const position = Number.parseInt(raw, 10);
  if (position < 1) {
    return undefined;
  }
  return { action, position };
}

/**
 * Render the transcript marker for the item at `index` (0-based): `> qN (N)`,
 * where N is the 1-based position.
 */
export function formatMainQueueMarker(index: number): string {
  const n = index + 1;
  return `> q${n} (${n})`;
}

/** Remove the item at `index`; returns the caller the mutated copy (non-destructive). */
export function removeMainQueueItem(
  items: readonly QueuedMainQuestion[],
  index: number,
): QueuedMainQuestion[] {
  if (index < 0 || index >= items.length) return [...items];
  const next = [...items];
  next.splice(index, 1);
  return next;
}

/**
 * "edit": pull the item at `index` out of the queue so its text can go back
 * into the composer. Returns `{ text, rest, removed }` where `removed` is the
 * item itself (so the caller can re-queue it), or `undefined` when out of
 * range.
 */
export function editMainQueueItem(
  items: readonly QueuedMainQuestion[],
  index: number,
): { text: string; rest: QueuedMainQuestion[]; removed: QueuedMainQuestion } | undefined {
  if (index < 0 || index >= items.length) return undefined;
  const rest = [...items];
  const removed = rest.splice(index, 1)[0]!;
  return { text: removed.question, rest, removed };
}

/**
 * Re-queue an edited item back at the SAME position (the position it held
 * before being pulled for editing). `at` is the original index; clamped to a
 * valid range so a reflowed-but-smaller queue never throws.
 */
export function reinsertMainQueueItem(
  items: readonly QueuedMainQuestion[],
  at: number,
  item: QueuedMainQuestion,
): QueuedMainQuestion[] {
  const next = [...items];
  const insertAt = Math.max(0, Math.min(at, next.length));
  next.splice(insertAt, 0, item);
  return next;
}
