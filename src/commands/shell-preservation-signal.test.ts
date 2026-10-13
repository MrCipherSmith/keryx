import { expect, test } from "bun:test";
import { makeSignalShutdown, type SignalShutdownParts } from "./shell";
test("signal awaits preservation before releasing ownership, repeated signal joins", async () => {
  const order: string[] = [];
  let unblock: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let done: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => { done = resolve; });
  const shutdown = makeSignalShutdown({
    busBox: { current: { leave: () => { order.push("bus"); } } as unknown as SignalShutdownParts["busBox"]["current"] },
    leaseBox: { current: {} as NonNullable<SignalShutdownParts["leaseBox"]["current"]> },
    jobRegistryBox: { current: undefined },
    preserve: async () => { order.push("checkpoint"); await blocked; order.push("outbox"); },
    releaseLease: () => { order.push("release"); }, closeMcp: async () => {},
    closeReadline: () => {}, exit: done,
  }, 143);
  shutdown(); shutdown();
  await Promise.resolve();
  expect(order).toEqual(["checkpoint"]);
  unblock();
  expect(await exited).toBe(143);
  expect(order).toEqual(["checkpoint", "outbox", "bus", "release"]);
});

test("signal exits when both job sweep and MCP close never settle", async () => {
  const order: string[] = [];
  let done: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => { done = resolve; });
  const shutdown = makeSignalShutdown({
    busBox: { current: undefined }, leaseBox: { current: undefined },
    jobRegistryBox: { current: { sweepAll: () => {
      order.push("jobs"); return new Promise<never>(() => {});
    } } },
    preserve: async () => { order.push("preserved"); },
    releaseLease: () => { order.push("released"); },
    closeMcp: () => { order.push("mcp"); return new Promise<void>(() => {}); },
    closeReadline: () => { order.push("readline"); },
    exit: done, cleanupTimeoutMs: 5,
  }, 143);
  shutdown(); shutdown();
  expect(await exited).toBe(143);
  expect(order).toEqual(["preserved", "released", "jobs", "mcp", "readline"]);
});

test("handlers sharing one guard start a single shutdown; a later signal forces the exit", async () => {
  const started: string[] = [];
  const exits: number[] = [];
  const guard = { startedAt: undefined as number | undefined };
  const make = (code: number) => makeSignalShutdown({
    guard, forceGraceMs: 0,
    busBox: { current: undefined }, leaseBox: { current: {} as NonNullable<SignalShutdownParts["leaseBox"]["current"]> },
    jobRegistryBox: { current: undefined },
    preserve: () => { started.push(String(code)); return new Promise<void>(() => {}); },
    releaseLease: () => { started.push("release"); }, closeMcp: async () => {},
    closeReadline: () => {}, exit: (c) => { exits.push(c); },
  }, code);
  const sigint = make(130); const sigterm = make(143);
  sigint();
  expect(started).toEqual(["130"]);
  sigterm();
  expect(started).toEqual(["130", "release"]);
  expect(exits).toEqual([143]);
});
