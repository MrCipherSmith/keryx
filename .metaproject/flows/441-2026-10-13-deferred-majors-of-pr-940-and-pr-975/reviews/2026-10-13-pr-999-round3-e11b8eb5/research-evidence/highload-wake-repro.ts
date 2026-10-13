// review-highload round 3: concurrency / re-entrancy probes of the main-queue drain.
// Run from the worktree: cd /home/altsay/keryx-fdm-t3 && bun run <this file>
// Wires the REAL createMainQueueDrain and the REAL createBusWakeController the way tui-shell.ts does
// (isIdle = !destroyed && !sites.workInFlight() && queue.length === 0 && !held; runWake makes the
// shell busy synchronously, as runLine does at tui-shell.ts 9646-9659).
import { createMainQueueDrain, type QueuedMainQuestion } from "/home/altsay/keryx-fdm-t3/src/tui/main-queue";
import { createBusWakeController, createLeaseHoldController } from "/home/altsay/keryx-fdm-t3/src/tui/bus-wake";

const it = (id: string, q: string): QueuedMainQuestion => ({ id, question: q, displayQuestion: q });
const tick = () => new Promise((r) => setTimeout(r, 0));

function build(opts: { cap?: number; consumeInbox?: boolean } = {}) {
  const s = {
    queue: [] as QueuedMainQuestion[],
    busy: false,
    held: false,
    awaiting: false,
    eligible: false,
    wakes: 0,
    runWakes: 0,
    turns: [] as string[],
    paints: 0,
    cappedPrints: 0,
    onSettleCalls: 0,
  };
  const cap = opts.cap ?? 5;
  const wakeCtl = createBusWakeController({
    isIdle: () => !sites.workInFlight() && s.queue.length === 0 && !s.held,
    inbox: { hasWakeEligible: () => s.eligible },
    getWakes: () => s.wakes,
    incWakes: () => void (s.wakes += 1),
    cap: () => cap,
    runWake: () => {
      s.runWakes += 1;
      s.busy = true; // runLine -> foregroundOperation.begin() + startBusy, synchronous
      s.turns.push("<bus-wake>");
      if (opts.consumeInbox) s.eligible = false; // the turn drains the inbox
    },
    printCapped: () => void (s.cappedPrints += 1),
    hasBusDeps: () => true,
  });
  const sites = createMainQueueDrain({
    forced: { takeNext: () => undefined, pendingCount: 0, get isAwaitingSettlement() { return s.awaiting; } },
    queue: () => s.queue,
    paint: () => void (s.paints += 1),
    run: (n) => {
      s.turns.push(n.question);
      if (!n.question.startsWith("/")) s.busy = true;
      s.wakes = 0; // runQueued -> runLine(..., "operator") resets consecutiveAutoWakes (tui-shell.ts 8327)
    },
    workInFlight: () => s.busy || s.awaiting,
    onSettle: () => {
      s.onSettleCalls += 1;
      wakeCtl.onSettle();
    },
  });
  const settleTurn = () => {
    s.busy = false;
    sites.onTurnSettle();
  };
  return { s, sites, wakeCtl, settleTurn };
}

// P1: turn settle and the end of detached work land in the same tick, inbox eligible.
{
  const { s, sites, settleTurn } = build();
  s.eligible = true;
  let end!: () => void;
  s.busy = true;
  sites.detach(new Promise<void>((r) => (end = r)));
  end(); // detached promise resolves; its `end` reaction is a microtask
  settleTurn(); // the turn settles synchronously first
  await tick();
  console.log("P1 settle + detach-end same tick: runWakes =", s.runWakes, "(1 expected = no double wake)");
}

// P2: lease release and the same poll's bus-wake poll.
{
  const { s, wakeCtl } = build();
  s.eligible = true;
  s.held = true;
  const lease = createLeaseHoldController({ isHeld: () => s.held, onRelease: () => void 0 });
  lease.onPoll();
  s.held = false;
  // tui-shell: onRelease -> drainSites.onLeaseRelease ; then onBusWakePoll(delivered)
  const b = build();
  b.s.eligible = true;
  b.s.held = true;
  const lc = createLeaseHoldController({ isHeld: () => b.s.held, onRelease: () => b.sites.onLeaseRelease() });
  lc.onPoll();
  b.s.held = false;
  lc.onPoll(); // release -> drain -> empty -> onSettle -> wake
  b.wakeCtl.onPoll(true); // same poll: second evaluation
  console.log("P2 lease release + same-poll onPoll: runWakes =", b.s.runWakes, "(1 expected)");
  void s; void wakeCtl;
}

// P3: three sites in one tick (operation complete, turn settle, lease release, detach end).
{
  const { s, sites } = build();
  s.eligible = true;
  sites.onForegroundOperationComplete();
  sites.onTurnSettle();
  sites.onLeaseRelease();
  console.log("P3 four sites one tick: runWakes =", s.runWakes, "onSettleCalls =", s.onSettleCalls, "(wake once; later sites see busy)");
}

// P4: wake loop. The inbox is never consumed (worst case); what bounds it?
{
  const { s, settleTurn } = build({ cap: 5 });
  s.eligible = true;
  settleTurn();
  for (let i = 0; i < 50; i++) settleTurn();
  console.log("P4 loop, no operator input: runWakes =", s.runWakes, "cappedPrints =", s.cappedPrints, "(cap 5, one capped notice)");
}

// P5: wake loop reset by a queued operator line (runQueued resets the counter).
{
  const { s, settleTurn } = build({ cap: 2 });
  s.eligible = true;
  for (let round = 0; round < 3; round++) {
    s.queue.push(it("q" + round, "line" + round));
    for (let i = 0; i < 10; i++) settleTurn();
  }
  console.log("P5 queued operator lines reset the counter each round: runWakes =", s.runWakes, "(<= cap per operator line)");
}

// P6: re-entrant drain: run() synchronously settles (no real path does this; model only).
{
  const s = { queue: [it("a", "/a"), it("b", "/b")], settles: 0, ran: [] as string[], paints: 0 };
  const sites: ReturnType<typeof createMainQueueDrain<QueuedMainQuestion>> = createMainQueueDrain({
    forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },
    queue: () => s.queue,
    paint: () => void (s.paints += 1),
    run: (n) => {
      s.ran.push(n.id);
      if (n.id === "a") sites.onTurnSettle(); // synchronous settle inside run
    },
    workInFlight: () => false,
    onSettle: () => void (s.settles += 1),
  });
  sites.onTurnSettle();
  console.log("P6 re-entrant settle inside run: ran =", s.ran.join(","), "onSettle calls =", s.settles, "(extra onSettle, idempotent in the controller; no double dispatch)");
}

// P7: a throwing `end` (run throws inside the detach-end drain).
{
  const unhandled: unknown[] = [];
  process.on("unhandledRejection", (e) => unhandled.push(e));
  const sites = createMainQueueDrain({
    forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },
    queue: () => [it("a", "boom")],
    paint: () => {},
    run: () => {
      throw new Error("foreground operation owner is disposed");
    },
    workInFlight: () => false,
    onSettle: () => {},
  });
  let resolve!: () => void;
  sites.detach(new Promise<void>((r) => (resolve = r)));
  resolve();
  await tick();
  await tick();
  console.log("P7 throwing end: unhandled =", unhandled.length, "workInFlight after =", sites.workInFlight(), "(counter already lowered)");

  // P8: rejecting work: swallowed by then(end,end) (old .finally left a derived rejection)
  const before = unhandled.length;
  const sites2 = createMainQueueDrain({
    forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },
    queue: () => [],
    paint: () => {},
    run: () => {},
    workInFlight: () => false,
    onSettle: () => {},
  });
  sites2.detach(Promise.reject(new Error("switchTo failed")));
  await tick();
  console.log("P8 rejecting work through detach: new unhandled =", unhandled.length - before, "(0 = error swallowed silently)");
  const old = Promise.reject(new Error("switchTo failed")).finally(() => {});
  void old;
  await tick();
  console.log("P8b old `.finally` shape: unhandled =", unhandled.length - before, "(1 = surfaced as unhandled rejection)");
}

// P9: detach of an already-settled promise: `end` is a microtask, so the queue is held for one tick.
{
  const { s, sites } = build();
  s.queue.push(it("a", "question"));
  sites.detach(Promise.resolve());
  sites.onLeaseRelease(); // inline, same tick
  console.log("P9 detach(settled) then lease release same tick: turns =", JSON.stringify(s.turns), "(held until microtask)");
  await tick();
  console.log("P9 after tick: turns =", JSON.stringify(s.turns));
}

// P10: detached work ends AFTER onDestroy (Ctrl+C): tui-shell.ts 3983-3985 set destroyed, cancel and dispose
// the real ForegroundOperationOwner; the drain sites have no destroyed/isDisposed guard, and a queued line
// reaches foregroundOperation.begin() (tui-shell.ts 9646), which throws on a disposed owner.
{
  const { ForegroundOperationOwner } = await import("/home/altsay/keryx-fdm-t3/src/tui/foreground-operation");
  const owner = new ForegroundOperationOwner();
  const unhandled: unknown[] = [];
  process.on("unhandledRejection", (e) => unhandled.push(e));
  const queue = [it("a", "question queued behind /model")];
  const sites = createMainQueueDrain({
    forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },
    queue: () => queue,
    paint: () => {},
    run: () => void owner.begin(), // runLine -> foregroundOperation.begin()
    workInFlight: () => owner.isActive,
    onSettle: () => {},
  });
  let resolve!: () => void;
  sites.detach(new Promise<void>((r) => (resolve = r))); // the /model picker
  owner.cancel("renderer destroyed");
  owner.dispose(); // onDestroy
  resolve(); // picker closes after destroy
  await tick();
  await tick();
  console.log("P10 detach-end after dispose: unhandled =", unhandled.length, String((unhandled[0] as Error | undefined)?.message), "queue left =", queue.length);
}
