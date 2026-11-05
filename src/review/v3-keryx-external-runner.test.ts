import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReviewV3AdapterRequest } from "./v3/types";
import type { ExternalBridgeSocketServer } from "./v3-external-transport";
import {
  createKeryxExternalGeneralRunner,
  type KeryxExternalChild,
  type KeryxExternalProcessPort,
} from "./v3-keryx-external-runner";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function dirs() {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-v3-runner-test-"));
  roots.push(root);
  const runDir = path.join(root, "source");
  const configDir = path.join(root, "state", "keryx");
  await mkdir(runDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  return { runDir, configDir };
}

function request(signal: AbortSignal): ReviewV3AdapterRequest {
  return {
    runId: "run-1", dispatchId: "general-1", taskId: "task-1", task: "Review auth boundaries", attempt: 1,
    revision: "deadbeef", entity: "review-coordinator", role: "coordinator", scopeIds: ["auth"], depth: 1, signal,
    limits: { elapsedMs: 60_000, modelRoundsDefault: 20, modelRoundsMax: 40, toolCallsMax: 80, maxChildLaunches: 8 },
  };
}

const server = {
  socketPath: "/tmp/bridge.sock",
  runDir: "/source",
  envFor: (token: string) => ({
    KERYX_REVIEW_V3_BRIDGE_SOCKET: "/tmp/bridge.sock",
    KERYX_REVIEW_V3_BRIDGE_TOKEN: token,
    KERYX_REVIEW_V3_BRIDGE_RUN_DIR: "/source",
  }),
  close: async () => undefined,
} satisfies ExternalBridgeSocketServer;

function input(signal = new AbortController().signal) {
  return {
    request: request(signal), signal,
    grant: { token: `bridge-${"x".repeat(32)}`, runId: "run-1", parentDispatchId: "general-1", expiresAt: Date.now() + 60_000 },
    bridge: { invoke: async () => ({ ok: false as const, code: "controller_error" as const, message: "unused" }) },
  };
}

test("verified runner launches Keryx under OS containment with bridge-only secret env", async () => {
  const { runDir, configDir } = await dirs();
  let spawned: Parameters<KeryxExternalProcessPort["spawn"]>[0] | undefined;
  const processPort: KeryxExternalProcessPort = {
    spawn(value) {
      spawned = value;
      return { stdout: Promise.resolve(`${JSON.stringify({ content: "consolidated review", metadata: { harness: "keryx-dedicated-review-v3-worker" } })}\n`), stderr: Promise.resolve(""), exited: Promise.resolve(0), terminateGroup() {}, groupAlive: () => false };
    },
  };
  const runner = await createKeryxExternalGeneralRunner({
    runDir, configDir, bridgeServer: server, workerCommand: ["/opt/bun", "/repo/src/review-v3-worker.ts"], provider: "openai-codex", model: "gpt-test", compileInstructions: () => "Trusted coordinator instructions", processPort,
    launcher: { available: true, platform: "darwin", path: "/usr/bin/sandbox-exec" },
    env: { PATH: "/bin", HOME: "/home/operator", OPENAI_API_KEY: "must-not-cross", ANTHROPIC_API_KEY: "must-not-cross" },
  });
  expect(await runner.execute(input())).toMatchObject({ content: "consolidated review", metadata: { externalHarness: "keryx-dedicated-review-v3-worker", containment: "darwin" } });
  expect(spawned?.argv[0]).toBe("/usr/bin/sandbox-exec");
  expect(spawned?.argv).toContain("/repo/src/review-v3-worker.ts");
  expect(spawned?.argv).not.toContain("shell");
  expect(spawned?.argv[2]).not.toContain(`(allow file-write* (subpath "${configDir}"))`);
  expect(spawned?.env.OPENAI_API_KEY).toBeUndefined();
  expect(spawned?.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(spawned?.env.KERYX_REVIEW_V3_BRIDGE_TOKEN).toStartWith("bridge-");
  expect(spawned?.env.HOME).not.toBe("/home/operator");
});

test("runner cancellation waits for process-group absence and returns stop evidence", async () => {
  const { runDir, configDir } = await dirs();
  const exit = Promise.withResolvers<number>();
  const started = Promise.withResolvers<void>();
  let alive = true;
  const child: KeryxExternalChild = {
    stdout: Promise.resolve(""), stderr: Promise.resolve(""), exited: exit.promise,
    terminateGroup(signal) { if (signal === "SIGTERM") { alive = false; exit.resolve(143); } },
    groupAlive: () => alive,
  };
  const runner = await createKeryxExternalGeneralRunner({
    runDir, configDir, bridgeServer: server, workerCommand: ["/opt/bun", "/repo/src/review-v3-worker.ts"], provider: "openai-codex", model: "gpt-test", compileInstructions: () => "Trusted coordinator instructions", processPort: { spawn: () => { started.resolve(); return child; } },
    launcher: { available: true, platform: "darwin", path: "/usr/bin/sandbox-exec" }, now: () => new Date("2026-11-05T00:00:00.000Z"),
  });
  const running = runner.execute(input());
  await started.promise;
  expect(await runner.cancel?.({ runId: "run-1", dispatchId: "general-1", reason: "stop" })).toEqual({
    stopped: true, observedAt: "2026-11-05T00:00:00.000Z", exitCode: 143,
  });
  await expect(running).rejects.toThrow("cancelled");
  expect(await runner.reconcile?.({ runId: "run-1", dispatchId: "general-1" })).toBe("cancelled");
});

test("runner refuses a read-only capability when no OS launcher is available", async () => {
  const { runDir, configDir } = await dirs();
  await expect(createKeryxExternalGeneralRunner({
    runDir, configDir, bridgeServer: server, provider: "openai-codex", model: "gpt-test", compileInstructions: () => "Trusted coordinator instructions",
    launcher: { available: false, platform: "darwin", reason: "missing" },
  })).rejects.toThrow("containment unavailable");
});

test("cancel during instruction compilation prevents launch and duplicate execute is fenced", async () => {
  const { runDir, configDir } = await dirs();
  const compiling = Promise.withResolvers<string>();
  let spawns = 0;
  const runner = await createKeryxExternalGeneralRunner({
    runDir, configDir, bridgeServer: server, workerCommand: ["/opt/bun", "/repo/src/review-v3-worker.ts"],
    provider: "openai-codex", model: "gpt-test", compileInstructions: () => compiling.promise,
    processPort: { spawn: () => { spawns += 1; throw new Error("must not spawn"); } },
    launcher: { available: true, platform: "darwin", path: "/usr/bin/sandbox-exec" },
  });
  const running = runner.execute(input());
  await expect(runner.execute(input())).rejects.toThrow("already active");
  expect(await runner.cancel?.({ runId: "run-1", dispatchId: "general-1", reason: "stop" })).toMatchObject({ stopped: true });
  compiling.resolve("Trusted coordinator instructions");
  await expect(running).rejects.toThrow("cancelled before process start");
  expect(spawns).toBe(0);
});
