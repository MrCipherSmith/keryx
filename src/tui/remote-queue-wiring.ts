// The calls the full-screen shell makes between its main queue, its session switches, its turn
// stream and the remote-control bridge (flow 376, extracted in flow 397).
//
// They lived inline in `tui-shell.ts`, where the OpenTUI renderer cannot be mounted by a unit test,
// so each one was guarded only by a test that read the source text. A deleted call kept those green
// (review of flow 376: F-010, F-014, F-015, F-016). The calls are here now, behind injected
// dependencies, and `remote-queue-wiring.test.ts` drives them against a real `RemoteBridge`.
// `tui-shell.ts` builds one wiring and calls it; it keeps no second copy of any of this.

import { type RemoteBridge, TG_SOURCE } from "../remote/shell-bridge";
import {
  dropQueuedBySource,
  editMainQueueItem,
  type PendingQueueEdit,
  pendingQueueEditFor,
  type QueuedMainQuestion,
  reinsertEditedMainQueueItem,
  removeMainQueueItem,
} from "./main-queue";

/** The part of {@link RemoteBridge} the shell's call sites use. */
export type RemoteQueueBridge = Pick<
  RemoteBridge,
  | "active"
  | "keepingTopic"
  | "disable"
  | "sessionLeaving"
  | "queuedLineRemoved"
  | "turnStarted"
  | "assistantText"
  | "toolCall"
  | "turnSettled"
>;

export interface RemoteQueueWiringDeps {
  /** The bridge, or undefined before it exists (it is built late in the shell). */
  getBridge(): RemoteQueueBridge | undefined;
  getQueue(): QueuedMainQuestion[];
  setQueue(next: QueuedMainQuestion[]): void;
  /** A fresh queue item id. */
  nextId(): string;
  /** A one-line label for a queued line. */
  summarize(text: string): string;
  /** Redraw the queue panel. */
  paint(): void;
  /** The composer: where an edited line goes back to. */
  composer: { setText(text: string): void; focus(): void };
  /** One line in the transcript. */
  say(text: string): void;
  /** Run a line as the operator's, labelled with where it came from. */
  runLine(line: string, origin: "operator", source?: typeof TG_SOURCE): void;
}

export interface RemoteQueueWiring {
  /** `/queue remove`, the Delete button: a Telegram line that is thrown away is reported to its topic. */
  removeMainQueue(index: number): void;
  /** `/queue edit`, the Edit button: the line goes to the composer and remembers where it came from. */
  editMainQueue(index: number): void;
  /** The next busy submit re-queues an edited line at its place. True when it did (the caller returns). */
  requeuePendingEdit(line: string, displayLine: string): boolean;
  /** Whether an edit is waiting for the next submit. */
  hasPendingEdit(): boolean;
  /** `/new`, `/clear`, `/resume` and the startup picker: the topic follows the session or is turned off first. */
  stopRemoteForSessionSwitch(): void;
  /** Remote control is going off: take the Telegram lines out of the queue and return their text. */
  dropQueuedTelegramLines(): string[];
  /** A line from the topic while the shell is busy: queue it, labelled. */
  enqueueTelegramLine(text: string): void;
  /** A line from the topic while the shell is idle: run it, labelled. */
  runTelegramLine(text: string): void;
  /** Run a queued item the way it was queued (a Telegram line keeps its label and so its reply path). */
  runQueued(item: QueuedMainQuestion): void;
  /** A turn begins: the bridge learns whether it came from Telegram. */
  turnStarted(source: typeof TG_SOURCE | undefined): void;
  /** Text a human would read. */
  assistantText(text: string): void;
  /** Wrap `io.onToolCall`: the bridge drops the text said before the call, then the original runs. */
  wrapOnToolCall<A extends unknown[]>(base: ((...args: A) => void) | undefined): (...args: A) => void;
  /** The turn finished; cancelled and failed turns say so in the topic. */
  turnSettled(outcome: { failed: boolean; aborted: boolean }): Promise<void>;
}

export function createRemoteQueueWiring(deps: RemoteQueueWiringDeps): RemoteQueueWiring {
  let pendingEdit: PendingQueueEdit | undefined;

  return {
    removeMainQueue(index) {
      const queue = deps.getQueue();
      if (index < 0 || index >= queue.length) return;
      // A Telegram line that is thrown away would leave its author waiting: tell the topic.
      const removed = queue[index];
      if (removed?.source === TG_SOURCE) {
        deps.getBridge()?.queuedLineRemoved(removed.question);
      }
      deps.setQueue(removeMainQueueItem(queue, index));
      deps.paint();
    },

    editMainQueue(index) {
      const edited = editMainQueueItem(deps.getQueue(), index);
      if (edited === undefined) return;
      deps.setQueue(edited.rest);
      // `source` travels with the edit: a Telegram line stays a Telegram line.
      pendingEdit = pendingQueueEditFor(edited.removed, index);
      deps.composer.setText(edited.text);
      deps.composer.focus();
      deps.paint();
    },

    requeuePendingEdit(line, displayLine) {
      if (pendingEdit === undefined) return false;
      const edit = pendingEdit;
      pendingEdit = undefined;
      deps.setQueue(reinsertEditedMainQueueItem(deps.getQueue(), edit, line, displayLine));
      deps.paint();
      return true;
    },

    hasPendingEdit: () => pendingEdit !== undefined,

    stopRemoteForSessionSwitch() {
      const bridge = deps.getBridge();
      // Flow 387 (AC17): a `/new`, `/clear` or `/resume` typed in the Telegram topic keeps the
      // topic. The history interval closes on the session being left; `sessionEntered` opens
      // the next one right after the live session is replaced.
      if (bridge?.keepingTopic === true) {
        bridge.sessionLeaving();
        return;
      }
      if (bridge?.active !== true) return;
      // The close is asynchronous (it deregisters, which deletes the topic): say it is
      // being turned off now, and that the topic is gone only once it really is. `disable`
      // takes the queued Telegram lines out before its first await, so none is left behind.
      const closing = bridge.disable();
      deps.say("◇ remote control is turning off: the session changed, and its Telegram topic is being deleted. Turn it on again with /remote-control <name>.\n");
      void closing.then(() => deps.say("◇ remote control off: the topic is deleted.\n"));
    },

    dropQueuedTelegramLines() {
      const { kept, dropped } = dropQueuedBySource(deps.getQueue(), TG_SOURCE);
      if (dropped.length === 0) return [];
      deps.setQueue(kept);
      deps.paint();
      return dropped.map((item) => item.question);
    },

    enqueueTelegramLine(text) {
      const queue = deps.getQueue();
      queue.push({ id: deps.nextId(), question: text, displayQuestion: deps.summarize(text), source: TG_SOURCE });
      deps.paint();
      deps.say(`◇ a line from Telegram is queued as q${queue.length}.\n`);
    },

    runTelegramLine(text) {
      deps.runLine(text, "operator", TG_SOURCE);
    },

    runQueued(item) {
      deps.runLine(item.question, "operator", item.source);
    },

    turnStarted(source) {
      deps.getBridge()?.turnStarted(source);
    },

    assistantText(text) {
      deps.getBridge()?.assistantText(text);
    },

    wrapOnToolCall(base) {
      return (...args) => {
        deps.getBridge()?.toolCall();
        base?.(...args);
      };
    },

    turnSettled(outcome) {
      const bridge = deps.getBridge();
      return bridge === undefined ? Promise.resolve() : bridge.turnSettled({ failed: outcome.failed || outcome.aborted });
    },
  };
}
