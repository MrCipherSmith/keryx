import { createMainQueueDrain, removeMainQueueItem, type QueuedMainQuestion } from "/home/altsay/keryx-fdm-t3/src/tui/main-queue";
const it = (id: string): QueuedMainQuestion => ({ id, question: id, displayQuestion: id });

function scenario(name: string, body: (s: any) => void) {
  let mainQueue: QueuedMainQuestion[] = [];
  const ran: string[] = [];
  let settles = 0;
  let busy = false;
  const forced: QueuedMainQuestion[] = [];
  const sites = createMainQueueDrain({
    forced: { takeNext: () => forced.shift(), get pendingCount() { return forced.length; }, isAwaitingSettlement: false },
    queue: () => mainQueue, // the shell's getter form (tui-shell.ts:7963)
    paint: () => {},
    run: (n) => { ran.push(n.question); busy = true; }, // a turn starts and the shell is busy until it settles
    workInFlight: () => busy,
    onSettle: () => { settles++; },
  });
  const s = {
    push: (x: string) => mainQueue.push(it(x)),
    remove: (i: number) => { mainQueue = removeMainQueueItem(mainQueue, i); },
    force: (i: number) => { const x = mainQueue[i]; mainQueue = removeMainQueueItem(mainQueue, i); forced.push(x); },
    settle: () => { busy = false; sites.onTurnSettle(); },
    sites,
  };
  body(s);
  console.log(name.padEnd(48), JSON.stringify({ ran, settles, liveQueue: mainQueue.map((q) => q.id) }));
}

scenario("control, no reassign: push a,b then settle", (s) => { s.push("a"); s.push("b"); s.settle(); });
scenario("remove q1 of [a,b] then settle", (s) => { s.push("a"); s.push("b"); s.remove(0); s.settle(); });
scenario("push a, remove it, push b, settle", (s) => { s.push("a"); s.remove(0); s.push("b"); s.settle(); });
scenario("force-style reassign on [x] then push b, settle", (s) => { s.push("x"); s.force(0); s.push("b"); s.settle(); });
scenario("remove all, settle: nothing runs, one wake", (s) => { s.push("a"); s.remove(0); s.settle(); });
