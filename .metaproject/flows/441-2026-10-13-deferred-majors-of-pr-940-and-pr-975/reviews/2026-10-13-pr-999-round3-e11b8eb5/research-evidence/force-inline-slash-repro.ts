import { createMainQueueDrain, type QueuedMainQuestion } from "./src/tui/main-queue";
import { createForegroundForceHandoff, createForegroundOperationOwner, forceForegroundQueueItem } from "./src/tui/foreground-operation";

const owner = createForegroundOperationOwner();
const handoff = createForegroundForceHandoff<QueuedMainQuestion>();
let busy = false;
let queue: QueuedMainQuestion[] = [];
const ran: string[] = [];
let settles = 0;
const sites = createMainQueueDrain({
  forced: handoff,
  queue: () => queue,
  paint: () => {},
  run: (n) => {
    ran.push(n.question);
    if (!n.question.startsWith("/")) {
      busy = true;
      owner.begin();
    }
  },
  workInFlight: () => busy || owner.isActive || handoff.isAwaitingSettlement,
  onSettle: () => {
    settles += 1;
  },
});
const item = (id: string, q: string): QueuedMainQuestion => ({ id, question: q, displayQuestion: q });

// a turn is running; queue [/compact, question]; the operator presses Force on /compact
busy = true;
const token = owner.begin();
const a = item("a", "/compact");
const b = item("b", "question");
queue = [b]; // forceMainQueue removed `a` from the queue
const forcing = forceForegroundQueueItem(owner, handoff, a, {
  // the shell passes remoteQueue.runQueued here: runLine of an inline slash command, no drain after it
  run: (n) => {
    ran.push(n.question);
  },
});
// the cancelled turn settles (shell finally-block): settle op, stopBusy, then drainSites.onTurnSettle()
owner.settle(token);
busy = false;
sites.onTurnSettle();
await forcing;
await new Promise((r) => setTimeout(r, 5));
console.log(JSON.stringify({ ran, queueLeft: queue.map((i) => i.question), settles, workInFlight: sites.workInFlight() }));
