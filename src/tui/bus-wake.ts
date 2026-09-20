// Flow 274 (agent bus P3, T7; specification §5.3): the TUI's bus-wake
// decision, factored out of `tui-shell.ts` as a small pure function so it is
// unit-testable without a renderer. Mirrors the existing task-notification
// wake (`resolveMaxAutoWake`, `consecutiveAutoWakes` — see
// `deps.jobRegistry?.onCompletion` in `tui-shell.ts`): a bus wake shares the
// SAME counter and the SAME cap, it just has its own eligibility source
// (`BusInbox.hasWakeEligible()` — specification §4.2 — instead of a finished
// task).

export interface BusWakeInput {
  /**
   * `!chrome.isBusy() && !foregroundOperation.isActive && mainQueue.length === 0`
   * (specification §5.3) — the SAME idle test the task-notification wake
   * uses. The caller is responsible for also checking the "destroyed" guard
   * (Ctrl+C) before ever constructing this input; this function has no
   * renderer to ask.
   */
  idle: boolean;
  /** `busInbox.hasWakeEligible()` (specification §4.2: question/reply/handoff, or a notice addressed by name — never a broadcast). */
  eligible: boolean;
  /** The current `consecutiveAutoWakes` count. */
  wakes: number;
  /** `resolveMaxAutoWake()`. */
  cap: number;
}

/**
 * - `"none"`: not idle, or nothing wake-eligible pending — do nothing.
 * - `"capped"`: idle and eligible, but `wakes >= cap` — print the capped
 *   message; do NOT increment the counter and do NOT start a turn (the
 *   message stays queued in the inbox for the next real turn to drain).
 * - `"wake"`: idle, eligible, under the cap — increment the counter and call
 *   `runLine("", "bus-message")`.
 */
export type BusWakeDecision = "none" | "capped" | "wake";

/** Pure decision table (specification §5.3) — see {@link BusWakeInput} for each field's meaning. */
export function decideBusWake(input: BusWakeInput): BusWakeDecision {
  if (!input.idle || !input.eligible) return "none";
  if (input.wakes >= input.cap) return "capped";
  return "wake";
}

/**
 * Review r1 F11: the stateful half of the TUI's bus-wake handling, extracted
 * from `tui-shell.ts`'s `onBusPollSettled` (both the poll-time call, wired
 * from `BusClient.onPeers`, and the turn-settle call) so it is unit-testable
 * without a renderer — `decideBusWake` above only ever covered the pure
 * decision table; the surrounding "when do we even ask, and what do we do
 * with a `capped`/`wake` answer" logic used to live only in `tui-shell.ts`
 * itself and was pinned by source-text audits (`tui-bus.test.ts`) and a
 * reimplemented copy of the loop (`delivery.integration.test.ts`) rather than
 * being exercised directly.
 *
 * Folds in two review r1 fixes that only make sense once this logic is in
 * one place:
 *
 * - F1: the capped notice used to reprint on every poll while the cap stayed
 *   reached (`onPeers` fires every ~1.5s). `printCapped` is now called at
 *   most once per pending batch — a flag is set the first time it prints and
 *   cleared once the inbox stops being wake-eligible (drained, emptied, or
 *   nothing new arrived) so the NEXT distinct backlog gets its own notice.
 *   `onPoll` also only evaluates anything when `newEvents` is true — a poll
 *   that delivered nothing new cannot itself justify a fresh decision;
 *   `onSettle` has no such gate, since a turn settling is itself the "check
 *   what's left" moment regardless of whether that particular turn delivered
 *   anything.
 * - F4: `hasBusDeps` guards BOTH entry points. A poll can land while the
 *   TUI's own join-success `deps` rebuild is still in flight (`await
 *   opts.makeAgentDeps(...)` in `tui-shell.ts`) — `deps.busInbox`/`busAck`
 *   are not attached yet, so a wake right then would start a turn with
 *   nothing to drain, burning the auto-wake budget on an empty round.
 */
export interface BusWakeControllerOptions {
  /** `!chrome.isBusy() && !foregroundOperation.isActive && mainQueue.length === 0` — read fresh at every decision, never cached. */
  isIdle: () => boolean;
  /** The live `BusInbox` this session drains from. */
  inbox: { hasWakeEligible(): boolean };
  /** The current `consecutiveAutoWakes` count — the SAME counter the task-notification wake shares. */
  getWakes: () => number;
  /** Increment `consecutiveAutoWakes` by one — called only on an actual `"wake"` decision. */
  incWakes: () => void;
  /** `resolveMaxAutoWake()` — read fresh at every decision (an operator override can change it mid-session). */
  cap: () => number;
  /** Start a bus-message turn (`runLine("", "bus-message")`). Never awaited here — same fire-and-forget shape the real call site already has. */
  runWake: () => void;
  /** Print the capped notice. Called at most once per pending batch (F1) — the caller need not throttle it itself. */
  printCapped: () => void;
  /**
   * True once this session's `deps` actually carries `busInbox`/`busAck`
   * (F4) — `() => deps.busInbox !== undefined` at the real call site. While
   * false, both `onPoll` and `onSettle` are a no-op: nothing is drainable yet,
   * so neither a wake nor a capped notice would mean anything.
   */
  hasBusDeps: () => boolean;
}

export interface BusWakeController {
  /**
   * Call after every poll settles (`BusClient.onPeers`, AFTER every event of
   * that poll was already routed to `onEvent`). `newEvents` is whether THIS
   * poll delivered at least one event to the inbox (F1) — a poll that found
   * nothing new is not a fresh reason to wake or to reprint the capped
   * notice; whatever was already pending stays exactly as pending as before.
   */
  onPoll(newEvents: boolean): void;
  /**
   * Call when a turn settles and no queued operator item ran instead. Unlike
   * `onPoll`, this always re-checks pending messages — a turn settling is
   * itself the moment to notice a still-backlogged inbox, whether or not
   * THIS turn is what delivered any of it.
   */
  onSettle(): void;
}

/** Build a {@link BusWakeController} — see its doc comment and {@link BusWakeControllerOptions} for the contract. */
export function createBusWakeController(opts: BusWakeControllerOptions): BusWakeController {
  // F1: set the first time `printCapped` runs for the CURRENT backlog;
  // cleared once the inbox is no longer wake-eligible (drained by a turn,
  // emptied some other way, or simply never refilled) so a later, distinct
  // capped episode is reported again rather than staying silenced forever.
  let cappedNoticeShown = false;

  function evaluate(): void {
    if (!opts.hasBusDeps()) return; // F4: nothing to drain into yet
    const eligible = opts.inbox.hasWakeEligible();
    if (!eligible) {
      cappedNoticeShown = false;
      return;
    }
    const decision = decideBusWake({
      idle: opts.isIdle(),
      eligible,
      wakes: opts.getWakes(),
      cap: opts.cap(),
    });
    if (decision === "none") return;
    if (decision === "capped") {
      if (!cappedNoticeShown) {
        cappedNoticeShown = true;
        opts.printCapped();
      }
      return;
    }
    cappedNoticeShown = false;
    opts.incWakes();
    opts.runWake();
  }

  return {
    onPoll(newEvents) {
      if (!newEvents) return; // F1: nothing new this poll — no fresh decision to make
      evaluate();
    },
    onSettle() {
      evaluate();
    },
  };
}

/**
 * Review r1 F10: `BusInbox.push` silently drops the oldest pending event once
 * the queue passes `MAX_PENDING_BUS_EVENTS` (`../bus/inbox.ts`) — the drop
 * itself was never surfaced to the operator. Lane A's `createBusInbox` now
 * accepts an `onDrop(droppedTotal)` callback for exactly this; this notifier
 * is the throttle in front of it, shared by both surfaces (TUI and
 * readline): a burst beyond the cap can drop many events in a row, and each
 * one would otherwise print its own "inbox full" line. One notice per
 * overflow EPISODE — printed the first time `onDrop` fires, silenced until
 * the caller reports (via `onInboxSizeObserved`) that the inbox emptied out,
 * so the next distinct episode gets its own notice again.
 */
export interface BusDropNotifier {
  /** Wire directly as `createBusInbox({ onDrop: notifier.onDrop })`. */
  onDrop(droppedTotal: number): void;
  /** Call with the inbox's current `size` wherever it is already observed (e.g. every poll) — resets the throttle once it reaches 0. */
  onInboxSizeObserved(size: number): void;
}

export function createBusDropNotifier(print: (droppedTotal: number) => void): BusDropNotifier {
  let shown = false;
  return {
    onDrop(droppedTotal) {
      if (shown) return;
      shown = true;
      print(droppedTotal);
    },
    onInboxSizeObserved(size) {
      if (size === 0) shown = false;
    },
  };
}

/** The exact operator-facing line review r1 F10 asks for. */
export function busInboxFullNotice(droppedTotal: number): string {
  return `bus: inbox full — ${droppedTotal} older message(s) dropped\n`;
}

// ---------------------------------------------------------------------------
// Flow 275 (agent bus P4, T7; specification §4.3, §5.2, AC4): pause-lease
// held turns. The GATE at each entry point (an operator line, `/queue force`,
// a side-worker dispatch for a busy line) is a plain `leaseView.held()`
// check made right at the call site in `tui-shell.ts` — there is no
// meaningful decision table to extract there, only "hold or proceed", and a
// dedicated pure function for that would just restate the boolean.
//
// The one genuinely stateful, bug-prone piece — same shape problem review r1
// F1 already solved for the bus-wake capped notice — is RELEASE: nothing in
// `tui-shell.ts` otherwise notices the moment a `turns` lease stops applying
// (`BusClient` refreshes `leaseView()` every poll, but reading a fresh
// boolean each time tells you the CURRENT state, never the TRANSITION into
// it), so the queue built up while held would sit forever unless something
// explicitly drains it right when the hold lifts (specification §5.2 step 5:
// "release the hold... " and AC4: "when the lease ends the held lines run").
// `createLeaseHoldController` is that something, following the exact
// held/wasHeld edge-detection shape `createBusWakeController` already uses
// for its own once-per-batch capped notice.
export interface LeaseHoldControllerOptions {
  /** `() => leaseView()?.held() === true` (specification §4.3) — read fresh on every poll, never cached. */
  isHeld: () => boolean;
  /**
   * Called exactly once, the poll where `isHeld()` flips from true to false —
   * never on a poll that was already released, and never merely because
   * nothing is currently held (that is simply "never true", not a release).
   * The caller drains its queue here exactly as a turn-settle would (FIFO
   * head, or a pending forced item first).
   */
  onRelease: () => void;
}

export interface LeaseHoldController {
  /** Call on every poll settle — same call site as `BusWakeController.onPoll`. */
  onPoll(): void;
}

/** Build a {@link LeaseHoldController} — see its own and {@link LeaseHoldControllerOptions}'s doc comments. */
export function createLeaseHoldController(opts: LeaseHoldControllerOptions): LeaseHoldController {
  let wasHeld = false;
  return {
    onPoll() {
      const held = opts.isHeld();
      if (wasHeld && !held) {
        opts.onRelease();
      }
      wasHeld = held;
    },
  };
}
