// Pure main-queue helpers for the TUI busy-input router (flow 167),
// GENERALISED to a queue per addressee (flow 176, T16).
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
//
// WHY THE MOVES ARE GENERIC (flow 176, package specification §7.5): an external
// child is a second addressee for the same queue behaviour, and its items carry
// more than a question (which run they are for, whether delivery is `force`).
// Copying the three moves for it would have produced a second implementation of
// `edit`-preserves-position that drifts from this one on the first bug fix, so
// the functions were WIDENED over the item type instead. Existing call sites are
// untouched: `T` infers to `QueuedMainQuestion` from their arguments.
// `src/tui/addressee-queue.ts` builds the per-addressee layer on top.

export interface QueuedMainQuestion {
  id: string;
  question: string;
  displayQuestion: string;
  /**
   * Flow 376: where the line came from, when not typed here. `"tg"` is a line
   * from the remote-control Telegram topic; the drain passes it back to
   * `runLine` so the turn is labelled and its reply goes back to the topic.
   * Absent for everything the operator typed.
   */
  source?: "tg";
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

/**
 * Remove the item at `index`; returns the caller the mutated copy
 * (non-destructive). Generic over the item type so a per-addressee queue can
 * carry a richer record through the same move (flow 176).
 */
export function removeMainQueueItem<T extends QueuedMainQuestion>(
  items: readonly T[],
  index: number,
): T[] {
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
export function editMainQueueItem<T extends QueuedMainQuestion>(
  items: readonly T[],
  index: number,
): { text: string; rest: T[]; removed: T } | undefined {
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
export function reinsertMainQueueItem<T extends QueuedMainQuestion>(
  items: readonly T[],
  at: number,
  item: T,
): T[] {
  const next = [...items];
  const insertAt = Math.max(0, Math.min(at, next.length));
  next.splice(insertAt, 0, item);
  return next;
}

/**
 * What `/queue edit` remembers about the item it pulled out: where it sat and
 * where it came from. `source` MUST travel with it, or an edited Telegram line
 * comes back unlabelled and its reply never reaches the topic.
 */
export interface PendingQueueEdit {
  id: string;
  at: number;
  source?: "tg";
}

export function pendingQueueEditFor(removed: QueuedMainQuestion, at: number): PendingQueueEdit {
  return { id: removed.id, at, ...(removed.source !== undefined ? { source: removed.source } : {}) };
}

/** Re-queue the edited text where it was, keeping the id and the source of the item it replaces. */
export function reinsertEditedMainQueueItem<T extends QueuedMainQuestion>(
  items: readonly T[],
  edit: PendingQueueEdit,
  question: string,
  displayQuestion: string,
): QueuedMainQuestion[] {
  return reinsertMainQueueItem<QueuedMainQuestion>(items, edit.at, {
    id: edit.id,
    question,
    displayQuestion,
    ...(edit.source !== undefined ? { source: edit.source } : {}),
  });
}

/** Split out the items that came from `source`: `dropped` in their queue order, `kept` the rest. */
export function dropQueuedBySource<T extends QueuedMainQuestion>(
  items: readonly T[],
  source: "tg",
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    (item.source === source ? dropped : kept).push(item);
  }
  return { kept, dropped };
}

/**
 * Drain a late main-queue choice only after the main turn is truly idle.
 * The caller supplies the live guard and repaints before dispatch. Taking the
 * forced item first preserves the existing settle/lease-release priority.
 */
export function drainIdleMainQueue<T extends QueuedMainQuestion>(
  items: T[],
  options: {
    isIdle: () => boolean;
    takeForced: () => T | undefined;
    dispatch: (item: T) => void;
  },
): boolean {
  if (!options.isIdle()) return false;
  const next = options.takeForced() ?? items.shift();
  if (next === undefined) return false;
  options.dispatch(next);
  return true;
}

/** What a queued message waits for (flow 426, AC6). */
export type QueueWait = { kind: "turn" } | { kind: "approval"; call: string };

export const QUEUE_FORCE_HELP =
  "[Force] interrupts the current turn and runs this message now · [Edit] moves it back to the composer · [Delete] removes it";

const PENDING_CALL_CHARS = 60;

/** One short line naming the call an approval is pending for: the shell command, else the tool name. */
export function describePendingCall(tool: string, inputJson: string): string {
  let shown = tool;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed !== null && typeof parsed === "object") {
      const command = (parsed as { command?: unknown }).command;
      if (typeof command === "string" && command.trim().length > 0) shown = command;
    }
  } catch {
    // not JSON: the tool name stands for the call
  }
  const oneLine = shown.replace(/\s+/g, " ").trim();
  return oneLine.length > PENDING_CALL_CHARS ? `${oneLine.slice(0, PENDING_CALL_CHARS - 1)}…` : oneLine;
}

export function queueWaitReason(wait: QueueWait): string {
  return wait.kind === "turn" ? "waits for the current turn" : `waits for approval of: ${wait.call}`;
}

/** The queue row: marker, text, state, and the reason it waits. */
export function formatQueueRow(index: number, text: string, wait: QueueWait): string {
  return `${formatMainQueueMarker(index)} ${text} — queued · ${queueWaitReason(wait)}`;
}

/** What `/queue` prints: the same rows the panel shows, then the one-line [Force] explanation. */
export function formatQueueListing(texts: readonly string[], wait: QueueWait): string[] {
  if (texts.length === 0) return ["main queue is empty."];
  return [...texts.map((text, index) => formatQueueRow(index, text, wait)), QUEUE_FORCE_HELP];
}
