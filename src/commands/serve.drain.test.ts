// A stop that rejects during `keryx serve` shutdown must be reported and must not skip the listener drain,
// the remote-control stop, or the final "stopped" that lets the process exit.
import { expect, test } from "bun:test";
import { drainServe } from "./serve";

test("a rejecting stop is reported and every later group still runs", async () => {
  const ran: string[] = []; const reported: string[] = [];
  await drainServe([
    [{ failure: "a failed", stop: async () => { ran.push("a"); } }, { failure: "bridges failed", stop: async () => { ran.push("bridges"); throw new Error("stop rejected"); } },
      { failure: "c failed", stop: () => { ran.push("c"); return Promise.resolve(); } }],
    [{ failure: "listener failed", stop: async () => { ran.push("listener"); } }],
    [{ failure: "remote failed", stop: async () => { ran.push("remote"); } }],
  ], (failure) => reported.push(failure));
  expect(ran).toEqual(["a", "bridges", "c", "listener", "remote"]);
  expect(reported).toEqual(["bridges failed"]);
});

test("a synchronous throw and a failing listener drain are reported too, and the drain still completes", async () => {
  const ran: string[] = []; const reported: string[] = [];
  await drainServe([
    [{ failure: "sync failed", stop: () => { throw new Error("sync"); } }],
    [{ failure: "listener failed", stop: async () => { throw new Error("drain"); } }],
    [{ failure: "remote failed", stop: async () => { ran.push("remote"); } }],
  ], (failure) => reported.push(failure));
  expect(ran).toEqual(["remote"]);
  expect(reported).toEqual(["sync failed", "listener failed"]);
});
