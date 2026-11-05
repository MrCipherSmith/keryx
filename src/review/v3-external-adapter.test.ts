import { expect, test } from "bun:test";
import {
  createExternalGeneralAdapter,
  createExternalGeneralBridge,
  type ExternalBridgeControllerPort,
  type ExternalBridgeRequest,
} from "./v3-external-adapter";
import type { ReviewV3AdapterRequest } from "./v3/types";

function fixture(options: {
  now?: () => number;
  authorize?: (operation: ExternalBridgeRequest["operation"]) => boolean | Promise<boolean>;
  terminal?: boolean;
} = {}) {
  const calls: Array<{ operation: string; parentDispatchId: string; targetDispatchId?: string }> = [];
  let next = 0;
  const port: ExternalBridgeControllerPort = {
    async spawn(parentDispatchId, input) {
      calls.push({ operation: "spawn", parentDispatchId });
      next += 1;
      return { ok: true, dispatchId: `child-${next}`, input };
    },
    isDescendant: (parentDispatchId, dispatchId) => {
      const numeric = Number(dispatchId.slice("child-".length));
      return calls[numeric - 1]?.parentDispatchId === parentDispatchId;
    },
    isTerminal: () => options.terminal ?? false,
    async status(dispatchId) {
      calls.push({ operation: "status", parentDispatchId: "", targetDispatchId: dispatchId });
      return { dispatchId, status: "running" };
    },
    async wait(dispatchId) {
      calls.push({ operation: "wait", parentDispatchId: "", targetDispatchId: dispatchId });
      return { dispatchId, status: "completed" };
    },
    async result(dispatchId) {
      calls.push({ operation: "result", parentDispatchId: "", targetDispatchId: dispatchId });
      return { dispatchId, content: "result" };
    },
    async cancel(dispatchId, reason) {
      calls.push({ operation: `cancel:${reason}`, parentDispatchId: "", targetDispatchId: dispatchId });
      return { dispatchId, status: "cancelled" };
    },
  };
  let token = 0;
  const bridge = createExternalGeneralBridge({
    runId: "run-1",
    controller: port,
    authorize: async ({ operation }) => options.authorize?.(operation) ?? true,
    now: options.now ?? (() => 1_000),
    tokenFactory: () => `opaque-${++token}-${"x".repeat(32)}`,
  });
  return { bridge, calls };
}

function leaf(taskId: string) {
  return { taskId, attempt: 1, entity: "review-worker", role: "worker" as const, adapterId: "native" };
}

const enforcement = {
  sourceSandbox: "read-only",
  resultWrites: "controller-only",
  hierarchy: "scoped-bridge",
  processCancellation: "handle",
  usageAccounting: false,
  toolProfile: "bridge-only",
  sourceRead: false,
  authRefresh: false,
} as const;

test("a grant is bound to its run and parent and never exposes credentials", async () => {
  const { bridge, calls } = fixture();
  const grant = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10_000 });
  expect(grant).toEqual({
    token: `opaque-1-${"x".repeat(32)}`,
    runId: "run-1",
    parentDispatchId: "general-1",
    expiresAt: 11_000,
  });
  expect(JSON.stringify(grant)).not.toContain("credential");
  expect(await bridge.invoke(grant.token, { operation: "spawn", input: leaf("leaf") })).toMatchObject({
    ok: true,
    value: { dispatchId: "child-1" },
  });
  expect(calls[0]).toEqual({ operation: "spawn", parentDispatchId: "general-1" });
});

test("every operation rechecks live host authority", async () => {
  let allowed = true;
  const { bridge, calls } = fixture({ authorize: () => allowed });
  const grant = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10_000 });
  const spawned = await bridge.invoke(grant.token, { operation: "spawn", input: leaf("leaf") });
  expect(spawned.ok).toBe(true);
  allowed = false;
  expect(await bridge.invoke(grant.token, { operation: "result", dispatchId: "child-1" })).toEqual({
    ok: false,
    code: "authority_denied",
    message: "host authority denied result",
  });
  expect(calls.filter((call) => call.operation === "result")).toHaveLength(0);
});

test("expiry and revocation fail closed before controller operations", async () => {
  let now = 1_000;
  const { bridge, calls } = fixture({ now: () => now });
  const expired = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10 });
  now = 1_010;
  expect(await bridge.invoke(expired.token, { operation: "spawn", input: leaf("leaf") })).toMatchObject({ ok: false, code: "token_expired" });
  const revoked = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10 });
  expect(await bridge.revoke(revoked.token)).toBe(true);
  expect(await bridge.invoke(revoked.token, { operation: "spawn", input: leaf("leaf") })).toMatchObject({ ok: false, code: "token_revoked" });
  expect(calls).toHaveLength(0);
});

test("a general cannot inspect or cancel another general's child", async () => {
  const { bridge, calls } = fixture();
  const a = bridge.issue({ parentDispatchId: "general-a", ttlMs: 10_000 });
  const b = bridge.issue({ parentDispatchId: "general-b", ttlMs: 10_000 });
  expect((await bridge.invoke(a.token, { operation: "spawn", input: leaf("a") }))).toMatchObject({ ok: true });
  expect((await bridge.invoke(b.token, { operation: "spawn", input: leaf("b") }))).toMatchObject({ ok: true });
  expect(await bridge.invoke(a.token, { operation: "cancel", dispatchId: "child-2", reason: "escape" })).toMatchObject({
    ok: false,
    code: "scope_denied",
  });
  expect(calls.filter((call) => call.operation.startsWith("cancel"))).toHaveLength(0);
});

test("operation allowlists are enforced independently from host authority", async () => {
  const { bridge } = fixture();
  const grant = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10_000, allowedOperations: ["spawn", "wait"] });
  expect(await bridge.invoke(grant.token, { operation: "status", dispatchId: "anything" })).toMatchObject({
    ok: false,
    code: "operation_denied",
  });
});

test("runtime request validation rejects missing dispatch ids before scope and controller access", async () => {
  const { bridge, calls } = fixture();
  const grant = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10_000 });
  expect(await bridge.invoke(grant.token, { operation: "status" } as never)).toMatchObject({ ok: false, code: "invalid_request" });
  expect(await bridge.invoke(grant.token, { operation: "cancel", reason: "all" } as never)).toMatchObject({ ok: false, code: "invalid_request" });
  expect(calls).toHaveLength(0);
});

test("spawn rejects unknown fields and coordinator children before the controller", async () => {
  const { bridge, calls } = fixture();
  const grant = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10_000 });
  const escaped = { ...leaf("leaf"), parentDispatchId: "other" };
  expect(await bridge.invoke(grant.token, { operation: "spawn", input: escaped as never })).toMatchObject({
    ok: false,
    code: "invalid_request",
  });
  expect(await bridge.invoke(grant.token, { operation: "spawn", input: { ...leaf("nested"), role: "coordinator" } as never })).toMatchObject({
    ok: false,
    code: "invalid_request",
  });
  expect(await bridge.invoke(grant.token, { operation: "spawn", input: { ...leaf("reserve"), budgetClass: "reserved" } as never })).toMatchObject({
    ok: false,
    code: "invalid_request",
  });
  expect(calls).toHaveLength(0);
});

test("idempotent reuse is scoped only after the controller proves ancestry", async () => {
  const { bridge, calls } = fixture();
  const grant = bridge.issue({ parentDispatchId: "general-b", ttlMs: 10_000 });
  // child-1 is recorded by the fake as belonging to a different parent.
  calls.push({ operation: "spawn", parentDispatchId: "general-a" });
  expect(await bridge.invoke(grant.token, { operation: "spawn", input: leaf("reused") })).toMatchObject({
    ok: false,
    code: "scope_denied",
  });
  expect(await bridge.invoke(grant.token, { operation: "status", dispatchId: "child-1" })).toMatchObject({ ok: false, code: "scope_denied" });
});

test("grant digests and subtree scope survive bridge restart without persisting bearer tokens", async () => {
  let saved: import("./v3-external-adapter").ExternalBridgeGrantSnapshot[] = [];
  const store = { load: () => saved, save: (next: readonly import("./v3-external-adapter").ExternalBridgeGrantSnapshot[]) => { saved = structuredClone([...next]); } };
  const { bridge } = fixture();
  // Build a bridge using the fixture's controller behavior and the durable store.
  const calls: string[] = [];
  const controller: ExternalBridgeControllerPort = {
    spawn: async () => ({ ok: true, dispatchId: "child-1" }),
    isDescendant: () => true,
    isTerminal: () => false,
    status: async (id) => { calls.push(id); return { status: "running" }; },
    wait: async () => ({}), result: async () => ({}), cancel: async () => ({}),
  };
  const token = `durable-${"z".repeat(32)}`;
  const first = createExternalGeneralBridge({ runId: "run-1", controller, authorize: () => true, now: () => 1_000, tokenFactory: () => token, grantStore: store });
  const grant = first.issue({ parentDispatchId: "general-1", ttlMs: 10_000 });
  await first.invoke(grant.token, { operation: "spawn", input: leaf("leaf") });
  expect(JSON.stringify(saved)).not.toContain(token);
  const reopened = createExternalGeneralBridge({ runId: "run-1", controller, authorize: () => true, now: () => 1_001, grantStore: store });
  expect(await reopened.invoke(token, { operation: "status", dispatchId: "child-1" })).toMatchObject({ ok: true });
  expect(calls).toEqual(["child-1"]);
  void bridge;
});

test("revokeParent invalidates every grant and cancels only its tracked children", async () => {
  const { bridge, calls } = fixture();
  const first = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10_000 });
  const second = bridge.issue({ parentDispatchId: "general-1", ttlMs: 10_000 });
  const other = bridge.issue({ parentDispatchId: "general-2", ttlMs: 10_000 });
  await bridge.invoke(first.token, { operation: "spawn", input: leaf("one") });
  await bridge.invoke(second.token, { operation: "spawn", input: leaf("two") });
  await bridge.invoke(other.token, { operation: "spawn", input: leaf("three") });
  await bridge.revokeParent("general-1", "parent stopped");
  expect(await bridge.invoke(first.token, { operation: "status", dispatchId: "child-1" })).toMatchObject({ ok: false, code: "token_revoked" });
  expect(calls.filter((call) => call.operation === "cancel:parent stopped").map((call) => call.targetDispatchId).sort()).toEqual(["child-1", "child-2"]);
});

function request(signal: AbortSignal): ReviewV3AdapterRequest {
  return {
    runId: "run-1",
    dispatchId: "general-1",
    taskId: "general-task",
    task: "review one behavioural area",
    attempt: 1,
    revision: "deadbeef",
    entity: "review-coordinator",
    role: "coordinator",
    scopeIds: ["area-1"],
    depth: 1,
    limits: {
      elapsedMs: 45 * 60_000,
      modelRoundsDefault: 120,
      modelRoundsMax: 600,
      toolCallsMax: 800,
      maxChildLaunches: 48,
    },
    signal,
  };
}

test("the adapter aborts the external runner and cancels its tracked subtree", async () => {
  const { bridge, calls } = fixture();
  let runnerSignal: AbortSignal | undefined;
  let grantToken: string | undefined;
  const runnerDone = Promise.withResolvers<{ content: string }>();
  const adapter = createExternalGeneralAdapter({
    id: "keryx-external-general",
    bridge,
    grantTtlMs: 60_000,
    runner: {
      enforcement,
      async execute(input) {
        runnerSignal = input.signal;
        grantToken = input.grant.token;
        await input.bridge.invoke(input.grant.token, { operation: "spawn", input: leaf("leaf") });
        return runnerDone.promise;
      },
      async cancel() { return { stopped: true, observedAt: "2026-11-05T00:00:00.000Z", exitCode: 143 }; },
    },
  });
  const running = adapter.execute(request(new AbortController().signal), {} as never);
  await Bun.sleep(1);
  await adapter.cancel?.({ runId: "run-1", dispatchId: "general-1", reason: "operator stopped" });
  expect(runnerSignal?.aborted).toBe(true);
  expect(calls.some((call) => call.operation === "cancel:operator stopped" && call.targetDispatchId === "child-1")).toBe(true);
  expect(await bridge.invoke(grantToken ?? "", { operation: "status", dispatchId: "child-1" })).toMatchObject({ ok: false, code: "token_revoked" });
  runnerDone.resolve({ content: "late result" });
  await running;
});

test("adapter cancellation fails closed when the runner cannot prove process exit", async () => {
  const { bridge } = fixture();
  const runnerDone = Promise.withResolvers<{ content: string }>();
  const adapter = createExternalGeneralAdapter({
    id: "keryx-external-general",
    bridge,
    grantTtlMs: 60_000,
    runner: {
      enforcement,
      async execute() { return runnerDone.promise; },
      async cancel() { return { stopped: false, reason: "process exit timed out" }; },
    },
  });
  const running = adapter.execute(request(new AbortController().signal), {} as never);
  await Bun.sleep(1);
  await expect(adapter.cancel?.({ runId: "run-1", dispatchId: "general-1", reason: "stop" })).rejects.toThrow(
    "process stop was not confirmed",
  );
  runnerDone.resolve({ content: "late" });
  await running;
});

test("normal adapter completion revokes the grant without cancelling terminal children", async () => {
  const { bridge, calls } = fixture({ terminal: true });
  let grantToken = "";
  const adapter = createExternalGeneralAdapter({
    id: "keryx-external-general",
    bridge,
    grantTtlMs: 60_000,
    runner: {
      enforcement,
      async execute(input) {
        grantToken = input.grant.token;
        await input.bridge.invoke(input.grant.token, { operation: "spawn", input: leaf("leaf") });
        return { content: "complete" };
      },
      async cancel() { return { stopped: true, observedAt: "2026-11-05T00:00:00.000Z", exitCode: 0 }; },
    },
  });
  expect(await adapter.execute(request(new AbortController().signal), {} as never)).toEqual({ content: "complete" });
  expect(calls.filter((call) => call.operation === "cancel:external general finished")).toHaveLength(0);
  expect(await bridge.invoke(grantToken, { operation: "status", dispatchId: "child-1" })).toMatchObject({ ok: false, code: "token_revoked" });
});
