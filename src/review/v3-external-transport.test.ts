import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { createExternalGeneralBridge, type ExternalBridgeControllerPort } from "./v3-external-adapter";
import {
  createExternalBridgeCliController,
  createExternalBridgeClientFromEnv,
  createExternalBridgeSocketClient,
  startExternalBridgeSocketServer,
} from "./v3-external-transport";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-v3-transport-test-"));
  roots.push(root);
  return root;
}
function leaf(taskId: string) {
  return { taskId, attempt: 1, entity: "review-worker", role: "worker" as const, adapterId: "native" };
}

async function harness() {
  const calls: string[] = [];
  const children = new Set<string>();
  const terminal = new Set<string>();
  const controller: ExternalBridgeControllerPort = {
    async spawn(parent, input) {
      calls.push(`spawn:${parent}:${input.taskId}`);
      const dispatchId = `d-${children.size + 1}`;
      children.add(dispatchId);
      return { ok: true, dispatchId, reused: false };
    },
    isDescendant: (_parent, dispatch) => children.has(dispatch),
    isTerminal: (dispatch) => terminal.has(dispatch),
    async status(dispatch) { calls.push(`status:${dispatch}`); return { dispatchId: dispatch, status: "running" }; },
    async wait(dispatch) { calls.push(`wait:${dispatch}`); terminal.add(dispatch); return { dispatchId: dispatch, status: "completed" }; },
    async result(dispatch) { calls.push(`result:${dispatch}`); return { dispatchId: dispatch, content: "done" }; },
    async cancel(dispatch, reason) { calls.push(`cancel:${dispatch}:${reason}`); terminal.add(dispatch); return { dispatchId: dispatch, status: "cancelled" }; },
  };
  const token = `transport-${"t".repeat(32)}`;
  const bridge = createExternalGeneralBridge({
    runId: "run-1",
    controller,
    authorize: () => true,
    now: () => 1_000,
    tokenFactory: () => token,
  });
  const grant = bridge.issue({ parentDispatchId: "general-1", ttlMs: 60_000 });
  const runDir = await tempRoot();
  const server = await startExternalBridgeSocketServer({ bridge, runDir });
  return { bridge, calls, grant, runDir, server };
}

test("socket transport carries scoped operations to the host-owned bridge", async () => {
  const h = await harness();
  try {
    const env = h.server.envFor(h.grant.token);
    expect(Object.keys(env).sort()).toEqual([
      "KERYX_REVIEW_V3_BRIDGE_RUN_DIR",
      "KERYX_REVIEW_V3_BRIDGE_SOCKET",
      "KERYX_REVIEW_V3_BRIDGE_TOKEN",
    ]);
    const { client, runDir } = createExternalBridgeClientFromEnv(env);
    expect(runDir).toBe(h.server.runDir);
    expect(await client.invoke({ operation: "spawn", input: leaf("leaf") })).toMatchObject({ ok: true, value: { dispatchId: "d-1" } });
    expect(await client.invoke({ operation: "wait", dispatchId: "d-1" })).toMatchObject({ ok: true, value: { status: "completed" } });
    expect(await client.invoke({ operation: "result", dispatchId: "d-1" })).toMatchObject({ ok: true, value: { content: "done" } });
    expect(h.calls).toEqual(["spawn:general-1:leaf", "wait:d-1", "result:d-1"]);
  } finally {
    await h.server.close();
  }
});

test("the socket is owner-only and the CLI wrapper cannot replace token-bound parent scope", async () => {
  const h = await harness();
  try {
    expect((await stat(h.server.socketPath)).mode & 0o777).toBe(0o600);
    const client = createExternalBridgeSocketClient({ socketPath: h.server.socketPath, token: h.grant.token });
    const cli = createExternalBridgeCliController(client);
    expect(() => cli.spawn(leaf("leaf"), "forged-parent")).toThrow("parent is bound");
    expect(await cli.spawn(leaf("leaf"))).toMatchObject({ ok: true, dispatchId: "d-1" });
    await expect(cli.status("foreign")).rejects.toMatchObject({ code: "scope_denied" });
  } finally {
    await h.server.close();
  }
});

test("missing bridge environment and wrong bearer fail closed", async () => {
  expect(() => createExternalBridgeClientFromEnv({})).toThrow("environment is incomplete");
  const h = await harness();
  try {
    const client = createExternalBridgeSocketClient({ socketPath: h.server.socketPath, token: `wrong-${"x".repeat(32)}` });
    expect(await client.invoke({ operation: "spawn", input: leaf("leaf") })).toMatchObject({ ok: false, code: "token_unknown" });
    expect(h.calls).toEqual([]);
  } finally {
    await h.server.close();
  }
});

test("oversized or malformed requests close only the offending connection", async () => {
  const h = await harness();
  await h.server.close();
  const server = await startExternalBridgeSocketServer({ bridge: h.bridge, runDir: h.runDir, maxLineBytes: 1024 });
  try {
    await new Promise<void>((resolve) => {
      const socket = createConnection(server.socketPath);
      socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, id: "bad", token: h.grant.token, request: { operation: "cancel", reason: "all" } })}\n`));
      socket.on("close", () => resolve());
      socket.on("error", () => undefined);
    });
    expect(h.calls).toEqual([]);
    await new Promise<void>((resolve) => {
      const socket = createConnection(server.socketPath);
      socket.on("connect", () => socket.write(`${"x".repeat(1025)}\n`));
      socket.on("close", () => resolve());
      socket.on("error", () => undefined);
    });
    const client = createExternalBridgeSocketClient({ socketPath: server.socketPath, token: h.grant.token });
    // The bridge remains available after rejecting another connection.
    expect(await client.invoke({ operation: "spawn", input: leaf("leaf") })).toMatchObject({ ok: true });
  } finally {
    await server.close();
  }
});

test("client abort closes the transport request", async () => {
  const root = await tempRoot();
  const socketPath = path.join(root, "never-created.sock");
  const client = createExternalBridgeSocketClient({ socketPath, token: `token-${"x".repeat(32)}`, timeoutMs: 60_000 });
  const abort = new AbortController();
  abort.abort();
  await expect(client.invoke({ operation: "status", dispatchId: "d" }, { signal: abort.signal })).rejects.toThrow("aborted");
});
