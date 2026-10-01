import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  drainIdleMainQueue,
  dropQueuedBySource,
  editMainQueueItem,
  formatMainQueueMarker,
  parseQueueCommand,
  pendingQueueEditFor,
  QueuedMainQuestion,
  reinsertEditedMainQueueItem,
  reinsertMainQueueItem,
  removeMainQueueItem,
} from "./main-queue";

const q = (id: string, question: string): QueuedMainQuestion => ({ id, question, displayQuestion: question });

test("formatMainQueueMarker renders qN (N)", () => {
  expect(formatMainQueueMarker(0)).toBe("> q1 (1)");
  expect(formatMainQueueMarker(1)).toBe("> q2 (2)");
  expect(formatMainQueueMarker(2)).toBe("> q3 (3)");
});

test("removeMainQueueItem is non-destructive and splices", () => {
  const items = [q("a", "A"), q("b", "B"), q("c", "C")];
  const out = removeMainQueueItem(items, 1);
  expect(items).toHaveLength(3); // original untouched
  expect(out.map((i) => i.id)).toEqual(["a", "c"]);
  // Out of range is a copy, not a throw.
  expect(removeMainQueueItem(items, 99)).toHaveLength(3);
  expect(removeMainQueueItem(items, -1)).toHaveLength(3);
});

test("editMainQueueItem pulls text out and returns rest + removed", () => {
  const items = [q("a", "A"), q("b", "B"), q("c", "C")];
  const edited = editMainQueueItem(items, 1)!;
  expect(edited.text).toBe("B");
  expect(edited.rest.map((i) => i.id)).toEqual(["a", "c"]);
  expect(edited.removed.id).toBe("b");
  expect(editMainQueueItem(items, 99)).toBeUndefined();
});

test("reinsertMainQueueItem puts an edited item back at its position (clamped)", () => {
  const rest = [{ ...q("a", "A") }, { ...q("c", "C") }];
  const re = reinsertMainQueueItem(rest, 1, { id: "b", question: "B2", displayQuestion: "B2" });
  expect(re.map((i) => i.id)).toEqual(["a", "b", "c"]);
  expect(re[1]!.question).toBe("B2");
  // Clamped: at beyond length appends, at negative prepends, never throws.
  expect(reinsertMainQueueItem(rest, 99, q("z", "Z")).map((i) => i.id)).toEqual(["a", "c", "z"]);
  expect(reinsertMainQueueItem(rest, -1, q("z", "Z")).map((i) => i.id)).toEqual(["z", "a", "c"]);
});

test("parseQueueCommand accepts remove/edit/force with an optional position (defaults to 1)", () => {
  expect(parseQueueCommand("remove")).toEqual({ action: "remove", position: 1 });
  expect(parseQueueCommand("remove 3")).toEqual({ action: "remove", position: 3 });
  expect(parseQueueCommand("  edit   2  ")).toEqual({ action: "edit", position: 2 });
  expect(parseQueueCommand("FORCE 1")).toEqual({ action: "force", position: 1 });
});

// Flow 176 T16: the three moves were WIDENED, not copied, so a per-addressee
// queue carrying a richer item runs the same remove/edit/reinsert code and
// cannot drift from the main queue on the next bug fix.
test("flow 176: the moves keep the item type, extra fields included", () => {
  type Addressed = QueuedMainQuestion & { addressee: string };
  const items: Addressed[] = [
    { ...q("a", "A"), addressee: "ext:1" },
    { ...q("b", "B"), addressee: "ext:1" },
  ];
  const removed = removeMainQueueItem(items, 0);
  expect(removed[0]?.addressee).toBe("ext:1");

  const edited = editMainQueueItem(items, 1)!;
  expect(edited.removed.addressee).toBe("ext:1");
  const back = reinsertMainQueueItem(edited.rest, 1, edited.removed);
  expect(back.map((item) => item.id)).toEqual(["a", "b"]);
  expect(back[1]?.addressee).toBe("ext:1");
});

test("parseQueueCommand rejects unknown actions and malformed positions", () => {
  expect(parseQueueCommand("")).toBeUndefined();
  expect(parseQueueCommand("bogus")).toBeUndefined();
  expect(parseQueueCommand("remove 0")).toBeUndefined();
  expect(parseQueueCommand("remove -1")).toBeUndefined();
  expect(parseQueueCommand("remove abc")).toBeUndefined();
  expect(parseQueueCommand("remove 1.5")).toBeUndefined();
});


test("late main choice after turn settlement starts its queued item exactly once", async () => {
  const items: QueuedMainQuestion[] = [];
  const dispatched: string[] = [];
  let busy = true;
  let chooseMain!: () => void;
  const choice = new Promise<void>((resolve) => { chooseMain = resolve; });
  const drain = () => drainIdleMainQueue(items, {
    isIdle: () => !busy,
    takeForced: () => undefined,
    dispatch: (item) => { dispatched.push(item.question); busy = true; },
  });
  const submit = (async () => { await choice; items.push(q("late", "late question")); drain(); })();
  busy = false;
  expect(drain()).toBe(false); // settlement saw an empty queue
  chooseMain();
  await submit; // the selector resolves AFTER settlement
  expect(dispatched).toEqual(["late question"]);
  expect(items).toHaveLength(0);
  busy = false;
  expect(drain()).toBe(false);
  expect(dispatched).toHaveLength(1);
});

test("a main choice made before settlement waits, then dispatches only once", async () => {
  const items = [q("queued", "queued question")];
  const dispatched: string[] = [];
  let busy = true;
  const opts = {
    isIdle: () => !busy,
    takeForced: () => undefined,
    dispatch: (item: QueuedMainQuestion) => { dispatched.push(item.question); busy = true; },
  };
  expect(drainIdleMainQueue(items, opts)).toBe(false);
  expect(items).toHaveLength(1);
  busy = false;
  expect(drainIdleMainQueue(items, opts)).toBe(true);
  expect(dispatched).toEqual(["queued question"]);
  expect(items).toHaveLength(0);
});

test("a late choice honours forced priority, FIFO, hold, and disposed guards", () => {
  const items = [q("old", "old"), q("late", "late")];
  const dispatched: string[] = [];
  let forced: QueuedMainQuestion | undefined = q("force", "force");
  let held = true;
  let disposed = false;
  const opts = {
    isIdle: () => !held && !disposed,
    takeForced: () => { const next = forced; forced = undefined; return next; },
    dispatch: (item: QueuedMainQuestion) => { dispatched.push(item.question); },
  };
  expect(drainIdleMainQueue(items, opts)).toBe(false);
  expect(forced?.id).toBe("force");
  held = false;
  expect(drainIdleMainQueue(items, opts)).toBe(true);
  expect(dispatched).toEqual(["force"]);
  expect(items.map((item) => item.id)).toEqual(["old", "late"]);
  expect(drainIdleMainQueue(items, opts)).toBe(true);
  disposed = true;
  expect(drainIdleMainQueue(items, opts)).toBe(false);
  expect(dispatched).toEqual(["force", "old"]);
  expect(items.map((item) => item.id)).toEqual(["late"]);
});

test("the busy recipient choice wires the idle drain after adding to the main queue", () => {
  const source = readFileSync(new URL("./tui-shell.ts", import.meta.url), "utf8");
  const choice = source.slice(source.indexOf('if (chosen === "main")'), source.indexOf('} else {', source.indexOf('if (chosen === "main")')));
  expect(choice).toContain("mainQueue.push(");
  expect(choice).toContain("drainIdleMainQueue(mainQueue, {");
  expect(choice.indexOf("mainQueue.push(")).toBeLessThan(choice.indexOf("drainIdleMainQueue(mainQueue, {"));
  for (const guard of ["!destroyed", "!chrome.isBusy()", "!foregroundOperation.isActive", "!forceHandoff.isAwaitingSettlement", "leaseView()?.held() !== true"]) {
    expect(choice).toContain(guard);
  }
});

// Flow 376 review (M2): `/queue edit` of a Telegram line must keep its source, or the
// reply of the turn it starts never reaches the topic.
test("editing a Telegram line and re-queuing it keeps source tg, so the drained turn is labelled", () => {
  const items: QueuedMainQuestion[] = [q("mq1", "typed"), { ...q("mq2", "from telegram"), source: "tg" }, q("mq3", "typed too")];
  const edited = editMainQueueItem(items, 1);
  expect(edited).toBeDefined();
  if (edited === undefined) return;
  const pending = pendingQueueEditFor(edited.removed, 1);
  expect(pending).toEqual({ id: "mq2", at: 1, source: "tg" });

  const requeued = reinsertEditedMainQueueItem(edited.rest, pending, "from telegram, reworded", "from telegram, reworded");
  expect(requeued.map((item) => item.id)).toEqual(["mq1", "mq2", "mq3"]);
  expect(requeued[1]).toEqual({ id: "mq2", question: "from telegram, reworded", displayQuestion: "from telegram, reworded", source: "tg" });

  // What the shell's drain hands to runLine: the source is still there.
  const dispatched: (QueuedMainQuestion | undefined)[] = [];
  const queue = requeued.slice(1);
  drainIdleMainQueue(queue, { isIdle: () => true, takeForced: () => undefined, dispatch: (item) => dispatched.push(item) });
  expect(dispatched[0]?.source).toBe("tg");
});

test("editing a typed line does not gain a source, and an absent source stays absent (exactOptionalPropertyTypes)", () => {
  const edited = editMainQueueItem([q("mq1", "typed")], 0);
  if (edited === undefined) throw new Error("expected an edit");
  const pending = pendingQueueEditFor(edited.removed, 0);
  expect("source" in pending).toBe(false);
  const requeued = reinsertEditedMainQueueItem([], pending, "typed again", "typed again");
  expect("source" in (requeued[0] ?? {})).toBe(false);
});

test("dropQueuedBySource splits the Telegram lines out in queue order and keeps the rest", () => {
  const items: QueuedMainQuestion[] = [
    { ...q("a", "tg one"), source: "tg" },
    q("b", "typed"),
    { ...q("c", "tg two"), source: "tg" },
  ];
  const { kept, dropped } = dropQueuedBySource(items, "tg");
  expect(kept.map((item) => item.id)).toEqual(["b"]);
  expect(dropped.map((item) => item.question)).toEqual(["tg one", "tg two"]);
  // Non-destructive: the input is untouched.
  expect(items).toHaveLength(3);
  expect(dropQueuedBySource([q("x", "typed")], "tg").dropped).toEqual([]);
});
