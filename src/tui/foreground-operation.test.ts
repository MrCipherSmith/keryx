import { expect, test } from "bun:test";
import type { AgentIO } from "../commands/agent";
import {
  createForegroundAgentIoFacade,
  createForegroundForceHandoff,
  createForegroundOperationOwner,
  finalizeWikiForegroundOperation,
  forceForegroundQueueItem,
  runAfterForegroundSettlement,
} from "./foreground-operation";

// Two Force presses arriving while one operation is still settling.
//
// This is the case review reached by deleting `if (!ownsSettlement) return;`
// from the shell: all four source-text assertions kept passing and the whole
// 101-test file stayed green, because those assertions read tui-shell.ts as
// TEXT and never ran it. The guard now lives in a function a test can call,
// and these tests call it.
//
// The invariant is the owner's: `begin()` throws when an operation is already
// active. A second waiter dispatching into the operation the first has
// re-opened is therefore not a silent mis-order — it is an exception thrown
// out of a floating promise, which is how it reached review twice before.
test("flow 219: a second Force during settlement does not open a second dispatch", async () => {
  const owner = createForegroundOperationOwner();
  const handoff = createForegroundForceHandoff<string>();
  const runs: string[] = [];

  const token = owner.begin();
  // `run` re-opens the operation exactly as `runLine` does in the shell, which
  // is what makes a second concurrent dispatch throw rather than merely
  // duplicate.
  const run = (item: string): void => {
    runs.push(item);
    owner.begin();
  };

  const first = forceForegroundQueueItem(owner, handoff, "q1", { run });
  const second = forceForegroundQueueItem(owner, handoff, "q2", { run });

  owner.settle(token);
  await Promise.all([first, second]);

  expect(runs).toEqual(["q1"]);
  expect(handoff.hasPending).toBe(true);
});

test("flow 219: the deferred press keeps its place for the next finalizer", async () => {
  // The second item is not lost, only deferred: it stays at the head of the
  // queue for the following foreground finalizer to drain in FIFO order.
  const owner = createForegroundOperationOwner();
  const handoff = createForegroundForceHandoff<string>();
  const runs: string[] = [];

  const token = owner.begin();
  await Promise.all([
    forceForegroundQueueItem(owner, handoff, "q1", { run: (i) => void runs.push(i) }),
    forceForegroundQueueItem(owner, handoff, "q2", { run: (i) => void runs.push(i) }),
    Promise.resolve().then(() => owner.settle(token)),
  ]);

  expect(runs).toEqual(["q1"]);
  expect(handoff.takeNext()).toBe("q2");
});

test("flow 219: forcing announces and cancels even when it does not own the settlement", async () => {
  // The deferred press must still cancel and still tell the operator, or the
  // second Ctrl-key press looks like it did nothing.
  const owner = createForegroundOperationOwner();
  const handoff = createForegroundForceHandoff<string>();
  const announced: number[] = [];

  const token = owner.begin();
  const signal = owner.signal;

  await Promise.all([
    forceForegroundQueueItem(owner, handoff, "q1", { run: () => {}, announce: () => void announced.push(1) }),
    forceForegroundQueueItem(owner, handoff, "q2", { run: () => {}, announce: () => void announced.push(2) }),
    Promise.resolve().then(() => owner.settle(token)),
  ]);

  expect(announced).toEqual([1, 2]);
  expect(signal.aborted).toBe(true);
});

test("flow 219: a Force-style handoff runs exactly once after the active operation settles", async () => {
  const owner = createForegroundOperationOwner();
  const operation = owner.begin();
  let runs = 0;

  const handoff = runAfterForegroundSettlement(owner, () => {
    runs += 1;
  });

  owner.cancel("forced queue item");
  owner.settle(operation);
  owner.settle(operation); // a stale duplicate finalizer must not run the handoff again
  await handoff;

  expect(runs).toBe(1);
});

test("flow 219: Force handoffs preserve every pre-settlement selection in order", async () => {
  const owner = createForegroundOperationOwner();
  const operation = owner.begin();
  const handoff = createForegroundForceHandoff<string>();
  const dispatched: string[] = [];

  expect(handoff.enqueue("first")).toBe(true);
  expect(handoff.enqueue("second")).toBe(false);

  const settleFirst = runAfterForegroundSettlement(owner, () => {
    const next = handoff.takeAfterSettlement();
    if (next !== undefined) dispatched.push(next);
  });

  owner.cancel("first item forced");
  owner.settle(operation);
  await settleFirst;

  const next = handoff.takeNext();
  if (next !== undefined) dispatched.push(next);

  expect(dispatched).toEqual(["first", "second"]);
  expect(handoff.takeNext()).toBeUndefined();
});

test("flow 219: disposal before settlement suppresses a deferred Force handoff", async () => {
  const owner = createForegroundOperationOwner();
  const operation = owner.begin();
  let runs = 0;
  const handoff = runAfterForegroundSettlement(owner, () => {
    runs += 1;
  });

  owner.dispose();
  owner.settle(operation);
  await handoff;

  expect(runs).toBe(0);
});

test("flow 219: wiki finalization clears live abort busy state without rendering or draining", () => {
  const events: string[] = [];
  const callbacks = {
    stopBusy: () => events.push("stopBusy"),
    complete: () => events.push("render-and-drain"),
  };

  expect(finalizeWikiForegroundOperation({ aborted: true, disposed: false }, callbacks)).toBe("aborted");
  expect(events).toEqual(["stopBusy"]);

  events.length = 0;
  expect(finalizeWikiForegroundOperation({ aborted: true, disposed: true }, callbacks)).toBe("disposed");
  expect(events).toEqual([]);
});

test("flow 219: a stale or disposed foreground AgentIO facade suppresses every callback and defaults approvals to deny", async () => {
  const owner = createForegroundOperationOwner();
  const operation = owner.begin();
  const received: string[] = [];
  const io: AgentIO = {
    write: (text) => received.push(`write:${text}`),
    onHistoryChange: (kind) => received.push(`history:${kind}`),
    onAssistantText: (text) => received.push(`assistant:${text}`),
    onReasoning: (text) => received.push(`reasoning:${text}`),
    onSystem: (text) => received.push(`system:${text}`),
    onAutoApproved: (tool) => received.push(`auto:${tool}`),
    requestApproval: async (tool) => {
      received.push(`approval:${tool}`);
      return true;
    },
  };
  const stale = createForegroundAgentIoFacade(owner, operation, io);

  stale.write("before");
  expect(await stale.requestApproval?.("shell_exec", "{}", undefined)).toBe(true);
  owner.settle(operation);
  const current = owner.begin();

  stale.write("late");
  stale.onHistoryChange?.("assistant_final");
  stale.onAssistantText?.("late");
  stale.onReasoning?.("late");
  stale.onSystem?.("late");
  stale.onAutoApproved?.("shell_exec", "{}", { destructive: false, credentials: false });
  expect(await stale.requestApproval?.("shell_exec", "{}", undefined)).toBe(false);

  owner.dispose();
  const disposed = createForegroundAgentIoFacade(owner, current, io);
  disposed.write("after dispose");
  expect(await disposed.requestApproval?.("shell_exec", "{}", undefined)).toBe(false);

  expect(received).toEqual(["write:before", "approval:shell_exec"]);
});

test("flow 219: an approval resolved after disposal remains denied", async () => {
  const owner = createForegroundOperationOwner();
  const operation = owner.begin();
  let resolveApproval!: (approved: boolean) => void;
  const approval = new Promise<boolean>((resolve) => {
    resolveApproval = resolve;
  });
  const io: AgentIO = { write: () => {}, requestApproval: async () => approval };
  const facade = createForegroundAgentIoFacade(owner, operation, io);

  const result = facade.requestApproval?.("shell_exec", "{}", undefined);
  owner.dispose();
  resolveApproval(true);

  expect(await result).toBe(false);
});
