import { expect, test } from "bun:test";
import type { AgentIO } from "../commands/agent";
import {
  createForegroundAgentIoFacade,
  createForegroundOperationOwner,
  runAfterForegroundSettlement,
} from "./foreground-operation";

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
