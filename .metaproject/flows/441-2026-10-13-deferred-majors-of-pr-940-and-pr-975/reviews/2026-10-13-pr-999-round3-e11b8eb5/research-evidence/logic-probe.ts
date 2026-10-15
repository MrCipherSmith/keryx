import { createMainQueueDrain } from "/home/altsay/keryx-fdm-t3/src/tui/main-queue";
const item = (id: string) => ({ id, question: id, displayQuestion: id });
process.on("unhandledRejection", (e) => console.log("UNHANDLED:", String(e)));
// 1. run throws from the detach-end drain (disposed shell: runLine -> begin() throws)
{
  let q = [item("x")];
  const s = createMainQueueDrain({ forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false }, queue: () => q, paint: () => {}, run: () => { throw new Error("owner is disposed"); }, workInFlight: () => false, onSettle: () => {} });
  let r!: () => void; s.detach(new Promise<void>((d) => (r = d))); r();
  await new Promise((d) => setTimeout(d, 5));
  console.log("1 inFlight after throw:", s.workInFlight(), "queue:", q.length);
}
// 2. empty drain with detached work in flight still calls onSettle
{
  let settles = 0;
  const s = createMainQueueDrain({ forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false }, queue: () => [], paint: () => {}, run: () => {}, workInFlight: () => false, onSettle: () => { settles++; } });
  s.detach(new Promise(() => {}));
  s.onTurnSettle();
  console.log("2 onSettle during detached:", settles, "inFlight:", s.workInFlight());
}
// 3. detach of an already-settled promise: queue held one microtask
{
  let ran: string[] = []; const q = [item("y")];
  const s = createMainQueueDrain({ forced: { takeNext: () => undefined, pendingCount: 0, isAwaitingSettlement: false }, queue: () => q, paint: () => {}, run: (i) => ran.push(i.id), workInFlight: () => false, onSettle: () => {} });
  s.detach(Promise.resolve());
  console.log("3 inline after detach(settled):", s.workInFlight(), ran);
  await Promise.resolve(); await Promise.resolve();
  console.log("3 after microtasks:", s.workInFlight(), ran);
}
