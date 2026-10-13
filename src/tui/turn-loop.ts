// The main turn loop's queue, built once (flow 441, AC1).
//
// The queue array, its id counter, the busy-time enqueue step, the remote-control wiring and the
// four drain sites used to be loose closures inside `launchTuiAgentShell`, where the OpenTUI renderer
// cannot be mounted by a unit test: AC1 ("a slash command queued behind a turn does not strand the
// lines behind it") was guarded by source text alone. They are here now behind injected dependencies,
// and `turn-loop.test.ts` drives the real `createMainQueueDrain` and `createRemoteQueueWiring` with a
// fake turn runner. `tui-shell.ts` builds one loop and calls it; it keeps no second copy.

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
  /** The live queue. It is replaced by `/queue remove`, `/queue edit` and Force, so read it each time. */
  readonly queue: QueuedMainQuestion[];
  replaceQueue(next: QueuedMainQuestion[]): void;
  /** Append a line and repaint; returns its 1-based position. */
  enqueue(line: string, displayLine: string, source?: QueuedMainQuestion["source"]): number;
  /**
   * A slash line typed while a turn runs. Queues it behind the turn and says so, unless it would
   * replace the session under the turn; false then, and the caller refuses it.
   */
  enqueueWhileBusy(line: string, displayLine: string, commandName: string | undefined, source?: QueuedMainQuestion["source"]): boolean;
  /** Run the head of the queue now when `isIdle`, the way the recipient choice does after its dock closes. */
  drainWhenIdle(isIdle: () => boolean): void;
  readonly remote: RemoteQueueWiring;
  readonly drain: ReturnType<typeof createMainQueueDrain<QueuedMainQuestion>>;
}

export function createTurnLoop(deps: TurnLoopDeps): TurnLoop {
  let queue: QueuedMainQuestion[] = [];
  let seq = 0;

  const enqueue: TurnLoop["enqueue"] = (line, displayLine, source) => {
    queue.push({ id: `mq${seq++}`, question: line, displayQuestion: displayLine, ...(source !== undefined ? { source } : {}) });
    deps.paint();
    return queue.length;
  };

  const remote = createRemoteQueueWiring({
    ...deps.remote,
    getQueue: () => queue,
    setQueue: (next) => {
      queue = next;
    },
    nextId: () => `mq${seq++}`,
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
    drainWhenIdle(isIdle) {
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
