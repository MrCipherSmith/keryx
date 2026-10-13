import { createMainQueueDrain, type QueuedMainQuestion } from "/home/altsay/keryx-fdm-t3/src/tui/main-queue.ts";
import { createBusWakeController } from "/home/altsay/keryx-fdm-t3/src/tui/bus-wake.ts";

const mk = (n: number): QueuedMainQuestion[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, question: `q${i}`, displayQuestion: `q${i}` }));

function build(initial: QueuedMainQuestion[], opts: { inline?: boolean } = {}) {
  const queue = initial;
  let busy = false;
  let paints = 0;
  let rowsBuilt = 0;
  let settles = 0;
  let ran = 0;
  let evals = 0, wakes = 0, hasElig = true, wakeCount = 0;
  const drain = createMainQueueDrain({
    forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false },
    queue: () => queue,
    paint: () => { paints++; rowsBuilt += queue.length; },
    run: () => { ran++; if (!opts.inline) busy = true; },
    workInFlight: () => busy,
    onSettle: () => { settles++; ctl.onSettle(); },
  });
  const ctl = createBusWakeController({
    isIdle: () => !drain.workInFlight() && queue.length === 0 && !busy,
    inbox: { hasWakeEligible: () => { evals++; return hasElig; } },
    getWakes: () => wakeCount, incWakes: () => { wakeCount++; wakes++; }, cap: () => 5,
    runWake: () => { busy = true; }, printCapped: () => {}, hasBusDeps: () => true,
  });
  return {
    drain,
    get paints() { return paints; }, get rowsBuilt() { return rowsBuilt; }, get settles() { return settles; },
    get ran() { return ran; }, get evals() { return evals; }, get wakes() { return wakes; },
    setElig: (b: boolean) => { hasElig = b; },
  };
}

{ const h = build([]); h.setElig(false); for (let i = 0; i < 100; i++) h.drain.onTurnSettle();
  console.log("1 empty settles x100:", { paints: h.paints, onSettle: h.settles, hasWakeEligible: h.evals, wakes: h.wakes }); }

{ const h = build([]); h.drain.onTurnSettle(); h.drain.onForegroundOperationComplete(); h.drain.onLeaseRelease();
  console.log("2 three sites one tick, eligible, wake sets busy sync:", { paints: h.paints, onSettle: h.settles, evals: h.evals, wakes: h.wakes }); }

{ const h = build(mk(50), { inline: true }); h.setElig(false); h.drain.onTurnSettle();
  console.log("3 50 inline lines:", { ran: h.ran, paints: h.paints, rowsBuiltIfFullRebuild: h.rowsBuilt, onSettle: h.settles }); }

(async () => {
  const h = build([]); h.setElig(false);
  h.drain.detach(Promise.reject(new Error("x")));
  h.drain.detach(Promise.resolve());
  console.log("4 before microtask: inFlight", h.drain.workInFlight());
  await new Promise((r) => setTimeout(r, 0));
  console.log("4 after:", { inFlight: h.drain.workInFlight(), paints: h.paints, onSettle: h.settles });
})();
