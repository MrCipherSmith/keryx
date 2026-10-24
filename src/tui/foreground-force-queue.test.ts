import { expect, test } from "bun:test";
import {
  createForegroundForceHandoff,
  createForegroundOperationOwner,
  forceForegroundQueueItem,
} from "./foreground-operation";

// flow 414 — Force must say what happened and must never drop the line.
//
// What the operator saw: pressing Force in the feed printed "main turn
// interrupted — q1 will run next" and then nothing ran. The line had already
// been taken out of the queue, and it was parked in a handoff that dropped it
// on every path that could not dispatch it.

test("cancel() reports whether it actually interrupted an operation", () => {
  const owner = createForegroundOperationOwner();
  expect(owner.cancel("nothing running")).toBe(false);
  const token = owner.begin();
  expect(owner.cancel("forced")).toBe(true);
  // A second press has nothing left to abort: the signal is already aborted.
  expect(owner.cancel("forced again")).toBe(false);
  owner.settle(token);
  expect(owner.cancel("after settle")).toBe(false);
});

test("a Force press with nothing to interrupt announces no interruption and still dispatches", async () => {
  const owner = createForegroundOperationOwner();
  const handoff = createForegroundForceHandoff<string>();
  const announced: boolean[] = [];
  const dispatched: string[] = [];
  await forceForegroundQueueItem(owner, handoff, "q1", {
    announce: (interrupted) => announced.push(interrupted),
    run: (item) => dispatched.push(item),
  });
  expect(announced).toEqual([false]);
  expect(dispatched).toEqual(["q1"]);
  expect(handoff.isAwaitingSettlement).toBe(false);
});

test("a line the busy branch would divert stays queued instead of being dispatched into it", async () => {
  const owner = createForegroundOperationOwner();
  const token = owner.begin();
  const handoff = createForegroundForceHandoff<string>();
  const dispatched: string[] = [];
  const resumed: number[] = [];
  const pending = forceForegroundQueueItem(owner, handoff, "q1", {
    run: (item) => dispatched.push(item),
    // No foreground operation is left after settlement, but the chrome is still
    // busy with detached work: `run` would be diverted to a side worker.
    isBusy: () => true,
    resume: () => resumed.push(1),
  });
  owner.settle(token);
  await pending;
  expect(dispatched).toEqual([]);
  expect(resumed).toEqual([1]);
  // Still queued for the next settle, and the flag that made every drain site
  // early-return is released.
  expect(handoff.pendingCount).toBe(1);
  expect(handoff.isAwaitingSettlement).toBe(false);
  expect(handoff.takeNext()).toBe("q1");
});

test("a session switch during settlement gives the forced line back instead of dropping it", async () => {
  const owner = createForegroundOperationOwner();
  const token = owner.begin();
  const handoff = createForegroundForceHandoff<string>();
  const dispatched: string[] = [];
  const requeued: string[][] = [];
  const pending = forceForegroundQueueItem(owner, handoff, "q1", {
    run: (item) => dispatched.push(item),
    requeue: (items) => requeued.push([...items]),
  });
  owner.invalidateSession();
  owner.settle(token);
  await pending;
  expect(dispatched).toEqual([]);
  // The waiter skipped its action, so nothing took the line: it must come back
  // through `requeue` rather than sit here forever with the queue stalled.
  expect(requeued).toEqual([["q1"]]);
  expect(handoff.hasPending).toBe(false);
  expect(handoff.isAwaitingSettlement).toBe(false);
});

test("drainPending gives every parked Force line back in FIFO order", () => {
  const handoff = createForegroundForceHandoff<string>();
  handoff.enqueue("q1");
  handoff.enqueue("q2");
  expect(handoff.isAwaitingSettlement).toBe(true);
  expect(handoff.drainPending()).toEqual(["q1", "q2"]);
  expect(handoff.isAwaitingSettlement).toBe(false);
  expect(handoff.hasPending).toBe(false);
  expect(handoff.drainPending()).toEqual([]);
});

test("releaseAwaitingSettlement unblocks the drain sites without losing the line", () => {
  const handoff = createForegroundForceHandoff<string>();
  handoff.enqueue("q1");
  handoff.releaseAwaitingSettlement();
  expect(handoff.isAwaitingSettlement).toBe(false);
  expect(handoff.pendingCount).toBe(1);
  expect(handoff.takeNext()).toBe("q1");
});
