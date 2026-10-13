// The main turn loop's queue, as one module (flow 441, AC1).
//
// The queue array, its id counter, the busy-time enqueue step, the idle dispatch after the recipient
// choice and the wiring of `createRemoteQueueWiring` and `createMainQueueDrain` (already factories since
// PR 999) used to be `let` bindings and closures inside `launchTuiAgentShell`. They sit here behind
// injected dependencies, and `turn-loop.test.ts` drives this module with a modelled `runLine`.
//
// The seam stops at `createTurnLoop`'s dependencies. What the shell passes in (`runLine`, `getBridge`,
// `say`, `onDetachedFailure`) and the shell's own call sites (the busy deferred branch, the lease-held
// notices, the idle predicate of the recipient choice, the settle call) are not run by that test. They are
// pinned as source text where their subject lives: tui-hold.test.ts (inputs, drain getter, held notices),
// busy-dispatch.test.ts, main-queue.test.ts, tui-bus.test.ts, and tui-shell.test.ts (Force).
// The OpenTUI renderer is still not mounted by any unit test.

import { deferredBusyAction, queuedCommandNotice } from "./busy-dispatch";
import {
  createMainQueueDrain,
  drainIdleMainQueue,
  type ForcedItems,
  type QueuedMainQuestion,
} from "./main-queue";
import { createRemoteQueueWiring, type RemoteQueueWiring, type RemoteQueueWiringDeps } from "./remote-queue-wiring";

export interface TurnLoopDeps {
  forced: ForcedItems<QueuedMainQuestion>;
  /** The bridge, the label for a queued line and the composer: the remote wiring's own inputs. */
  remote: Pick<RemoteQueueWiringDeps, "getBridge" | "summarize" | "composer">;
  /** Redraw the queue panel. */
  paint(): void;
  /** One line in the transcript. */
  say(text: string): void;
  /** Run a line as the operator's; the shell's `runLine`. */
  runLine: RemoteQueueWiringDeps["runLine"];
  /** A turn, a foreground operation or a pending force hand-off is in flight. */
  turnWorkInFlight(): boolean;
  /** The drain left nothing queued and started nothing, so the bus may wake. */
  onSettle(): void;
  /** Detached slash work rejected: say why. */
  onDetachedFailure(error: unknown): void;
}

export interface TurnLoop {
  /** The live queue, read-only here. `/queue remove`, `/queue edit` and Force replace it, so read it each time. */
  readonly queue: readonly QueuedMainQuestion[];
  /** Swap the queue array for `next`; the drain and the remote wiring read the new one from the next call on. */
  replaceQueue(next: QueuedMainQuestion[]): void;
  /** Append a line and repaint; returns its 1-based position. */
  enqueue(line: string, displayLine: string, source?: QueuedMainQuestion["source"]): number;
  /**
   * A slash line typed while a turn runs. Unlike `enqueue` it asks `deferredBusyAction` first: a command
   * that would replace the session under the turn is not queued and this returns false (the caller
   * refuses it). Otherwise it queues the line behind the turn, says "queued as q<N>" and returns true.
   */
  enqueueWhileBusy(line: string, displayLine: string, commandName: string | undefined, source?: QueuedMainQuestion["source"]): boolean;
  /**
   * After the recipient choice closes its dock: when `isIdle()`, run one item (a forced one first) and
   * repaint before it. It asks the caller's predicate only; it does not consult detached slash work
   * (`drain.workInFlight()`), unlike the drain's own idle drain. Not that function. The caller restates the
   * in-flight terms on purpose (the dock is the shell's, and `destroyed` is its own); the source pin in
   * main-queue.test.ts holds the whole predicate.
   */
  drainAfterRecipientChoice(isIdle: () => boolean): void;
  readonly remote: RemoteQueueWiring;
  readonly drain: ReturnType<typeof createMainQueueDrain<QueuedMainQuestion>>;
}

export function createTurnLoop(deps: TurnLoopDeps): TurnLoop {
  let queue: QueuedMainQuestion[] = [];
  let seq = 0;
  const nextId = (): string => `mq${seq++}`;

  const enqueue: TurnLoop["enqueue"] = (line, displayLine, source) => {
    queue.push({ id: nextId(), question: line, displayQuestion: displayLine, ...(source !== undefined ? { source } : {}) });
    deps.paint();
    return queue.length;
  };

  const remote = createRemoteQueueWiring({
    ...deps.remote,
    getQueue: () => queue,
    setQueue: (next) => {
      queue = next;
    },
    nextId,
    paint: deps.paint,
    say: deps.say,
    runLine: deps.runLine,
  });

  const drain = createMainQueueDrain({
    forced: deps.forced,
    queue: () => queue,
    paint: deps.paint,
    run: (next) => remote.runQueued(next),
    turnWorkInFlight: deps.turnWorkInFlight,
    onSettle: deps.onSettle,
    onDetachedFailure: deps.onDetachedFailure,
  });

  return {
    get queue() {
      return queue;
    },
    replaceQueue(next) {
      queue = next;
    },
    enqueue,
    enqueueWhileBusy(line, displayLine, commandName, source) {
      if (deferredBusyAction(line, commandName) !== "queue") return false;
      const position = enqueue(line, displayLine, source);
      deps.say(`${queuedCommandNotice(position)}\n`);
      return true;
    },
    drainAfterRecipientChoice(isIdle) {
      drainIdleMainQueue(queue, {
        isIdle,
        takeForced: () => deps.forced.takeNext(),
        dispatch: (next) => {
          deps.paint();
          remote.runQueued(next);
        },
      });
    },
    remote,
    drain,
  };
}
