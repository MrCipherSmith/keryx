import { createMainQueueDrain, type QueuedMainQuestion } from "./src/tui/main-queue";
import { createForegroundForceHandoff, createForegroundOperationOwner, forceForegroundQueueItem } from "./src/tui/foreground-operation";
const owner = createForegroundOperationOwner();
const handoff = createForegroundForceHandoff<QueuedMainQuestion>();
let busy = false; let queue: QueuedMainQuestion[] = []; const ran: string[] = []; let settles = 0;
const sites = createMainQueueDrain({
  forced: handoff, queue, paint: () => {},
  run: (n) => { ran.push(n.question); if (!n.question.startsWith("/")) { busy = true; owner.begin(); } },
  workInFlight: () => busy || owner.isActive || handoff.isAwaitingSettlement,
  onSettle: () => { settles += 1; },
} as any);
const item = (id: string, q: string): QueuedMainQuestion => ({ id, question: q, displayQuestion: q });
busy = true; const token = owner.begin();
const a = item("a", "/compact"); const b = item("b", "question"); queue.push(b);
const forcing = forceForegroundQueueItem(owner, handoff, a, { run: (n) => { ran.push(n.question); } });
owner.settle(token); busy = false; sites.onTurnSettle();
await forcing; await new Promise((r) => setTimeout(r, 5));
console.log(JSON.stringify({ ran, queueLeft: queue.map((i) => i.question), settles }));
