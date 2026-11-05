import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReviewAgentController, createLargeReviewConfig } from "../review/agents";
import { startExternalBridgeSocketServer } from "../review/agents/external-transport";
import { createReviewAgentCliFactory, reviewAgentsCliFactoryFromEnv, runReviewAgentsCommand, type ReviewAgentCliController, type ReviewAgentCliFactory } from "./review-agents";

function controller(): ReviewAgentCliController & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    capabilities: async (adapterId) => (calls.push(["capabilities", adapterId]), { adapters: ["native"] }),
    status: async (dispatchId) => (calls.push(["status", dispatchId]), { state: "running" }),
    spawn: async (input) => (calls.push(["spawn", input]), { ok: true, dispatchId: "d-1", reused: false }),
    wait: async (dispatchId) => (calls.push(["wait", dispatchId]), { state: "completed" }),
    cancel: async (dispatchId, reason) => (calls.push(["cancel", { dispatchId, reason }]), { cancelled: true }),
    result: async (dispatchId) => (calls.push(["result", dispatchId]), { output: "ok" }),
  };
}

function harness(c: ReviewAgentCliController = controller()) {
  const opened: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const factory: ReviewAgentCliFactory = {
    open: async (runDir) => {
      opened.push(runDir);
      return c;
    },
  };
  const run = (args: string[]) => runReviewAgentsCommand(args, { factory, log: (line) => out.push(line), error: (line) => err.push(line) });
  return { run, opened, out, err, controller: c };
}

describe("review agents CLI", () => {
  test("requires an explicit contained run directory for every operation", async () => {
    const h = harness();
    expect(await h.run(["status"])).toBe(1);
    expect(h.err.join("\n")).toContain("--run-dir");
    expect(h.opened).toEqual([]);
  });

  test("start requires explicit config, allowlists and cost mode, then delegates creation to the host", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-agents-cli-start-"));
    try {
      const configFile = path.join(root, "config.json");
      const config = createLargeReviewConfig({ allowedAdapters: ["native"], allowedEntities: ["review-worker"], allowedSkills: ["review-logic"], costMode: "cost-unknown" });
      writeFileSync(configFile, JSON.stringify(config));
      const created: unknown[] = [];
      const c = controller();
      const factory: ReviewAgentCliFactory = {
        open: async () => c,
        create: async (runDir, input) => (created.push({ runDir, input }), c),
      };
      const out: string[] = [];
      expect(await runReviewAgentsCommand(["start", "--run-dir", path.join(root, "run"), "--run-id", "r-1", "--revision", "abc", "--config", configFile], { factory, log: (line) => out.push(line), error: () => {} })).toBe(0);
      expect(created).toEqual([{ runDir: path.join(root, "run"), input: { runId: "r-1", revision: "abc", config } }]);
      expect(JSON.parse(out[0]!)).toEqual({ state: "running" });

      const unsafeFile = path.join(root, "unsafe.json");
      writeFileSync(unsafeFile, JSON.stringify({ ...config, authority: "admin" }));
      created.length = 0;
      expect(await runReviewAgentsCommand(["start", "--run-dir", path.join(root, "unsafe"), "--run-id", "r-2", "--revision", "abc", "--config", unsafeFile], { factory, log: () => {}, error: () => {} })).toBe(1);
      expect(created).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plan registers raw responsibility and waves through the host-owned factory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-agents-cli-plan-"));
    try {
      const runDir = path.join(root, "run");
      const config = createLargeReviewConfig({
        allowedAdapters: ["native"],
        allowedEntities: ["review-coordinator", "review-worker"],
        allowedSkills: ["review-logic"],
      });
      const factory = createReviewAgentCliFactory({
        adapters: [],
        authority: { authorize: () => true },
        ownerId: "cli-plan-owner",
        configCeiling: config,
      });
      await factory.create!(runDir, { runId: "plan-run", revision: "a".repeat(40), config });
      const payload = path.join(runDir, "plan.json");
      writeFileSync(payload, JSON.stringify({
        version: 1,
        plan: {
          revision: "a".repeat(40),
          planVersion: 1,
          areas: [{ id: "area-1", title: "Area one", requiredAspects: ["logic"], ownerAssignmentId: "general-1" }],
          boundaries: [],
          assignments: [
            { id: "general-1", agentInstanceId: "general-instance", kind: "coordinator", entity: "review-coordinator", areaIds: ["area-1"], scopeIds: ["src/a.ts"], coverage: [] },
            { id: "worker-1", agentInstanceId: "worker-instance", kind: "worker", entity: "review-worker", parentAssignmentId: "general-1", areaIds: ["area-1"], scopeIds: ["src/a.ts"], coverage: [{ areaId: "area-1", scopeId: "src/a.ts", aspect: "logic" }] },
          ],
        },
        waves: [{ waveId: "wave-1", reviewRound: 1, assignmentIds: ["general-1"] }],
      }));
      const out: string[] = [];
      expect(await runReviewAgentsCommand(["plan", "--run-dir", runDir, "--payload", payload], { factory, log: (line) => out.push(line), error: () => {} })).toBe(0);
      const registration = JSON.parse(out[0]!);
      expect(registration).toMatchObject({ planVersion: 1, revision: "a".repeat(40), waves: [{ waveId: "wave-1", reviewRound: 1 }] });
      expect(registration.planHash).toMatch(/^[a-f0-9]{64}$/);
      const liveController = await factory.open(runDir);
      const state = await liveController.status() as { activePlan: { planHash: string } };
      expect(state.activePlan.planHash).toBe(registration.planHash);

      const unsafePayload = path.join(runDir, "unsafe-plan.json");
      const decoded = JSON.parse(readFileSync(payload, "utf8"));
      writeFileSync(unsafePayload, JSON.stringify({ ...decoded, planHash: "caller-controlled" }));
      expect(await runReviewAgentsCommand(["plan", "--run-dir", runDir, "--payload", unsafePayload], { factory, log: () => {}, error: () => {} })).toBe(1);
      await liveController.close?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status-only and scoped descendant factories cannot register a root plan", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-agents-cli-plan-refusal-"));
    try {
      const payload = path.join(root, "plan.json");
      writeFileSync(payload, JSON.stringify({ version: 1, plan: { revision: "a".repeat(40), planVersion: 1, areas: [], boundaries: [], assignments: [] }, waves: [] }));
      for (const factory of [
        reviewAgentsCliFactoryFromEnv({}),
        reviewAgentsCliFactoryFromEnv({
          KERYX_REVIEW_AGENTS_BRIDGE_SOCKET: "/tmp/not-used.sock",
          KERYX_REVIEW_AGENTS_BRIDGE_TOKEN: "scoped-review-agents-token-0123456789abcdef",
          KERYX_REVIEW_AGENTS_BRIDGE_RUN_DIR: root,
        }),
      ]) {
        const errors: string[] = [];
        expect(await runReviewAgentsCommand(["plan", "--run-dir", root, "--payload", payload], { factory, log: () => {}, error: (line) => errors.push(line) })).toBe(1);
        expect(errors.join("\n")).toContain("host has no plan-registration binding");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opens the durable run and prints one JSON value", async () => {
    const h = harness();
    expect(await h.run(["capabilities", "--run-dir", "/tmp/review-agents", "--adapter", "native"])).toBe(0);
    expect(h.opened).toEqual(["/tmp/review-agents"]);
    expect(JSON.parse(h.out[0]!)).toEqual({ adapters: ["native"] });
    expect((h.controller as ReturnType<typeof controller>).calls).toEqual([["capabilities", "native"]]);
  });

  test("status accepts an optional dispatch id", async () => {
    const h = harness();
    expect(await h.run(["status", "--run-dir=/tmp/review-agents", "--dispatch", "d-7"])).toBe(0);
    expect((h.controller as ReturnType<typeof controller>).calls).toEqual([["status", "d-7"]]);
  });

  test("spawn reads a versioned payload and rejects unknown or authority fields before opening", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-agents-cli-"));
    try {
      const good = path.join(dir, "good.json");
      writeFileSync(good, JSON.stringify({ version: 1, taskId: "t-1", task: "Review scope s-1", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", adapterId: "native", scopeIds: ["s-1"] }));
      const ok = harness();
      expect(await ok.run(["spawn", "--run-dir", dir, "--payload", good])).toBe(0);
      expect((ok.controller as ReturnType<typeof controller>).calls[0]).toEqual(["spawn", { taskId: "t-1", task: "Review scope s-1", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", adapterId: "native", scopeIds: ["s-1"] }]);

      for (const payload of [
        { version: 2, taskId: "t", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", adapterId: "native", scopeIds: [] },
        { version: 1, taskId: "t", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", adapterId: "native", scopeIds: [], authority: "admin" },
        { version: 1, taskId: "t", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", adapterId: "native", scopeIds: [], parentDispatchId: "general-1" },
        { version: 1, taskId: "t", attempt: 1, entity: "review-worker", role: "worker", skillRef: "review-logic", adapterId: "native", scopeIds: [], budgetClass: "reserved" },
        { version: 1, taskId: "t", attempt: 0, entity: "review-worker", role: "worker", skillRef: "review-logic", adapterId: "native", scopeIds: [] },
      ]) {
        const file = path.join(dir, `${Math.random()}.json`);
        writeFileSync(file, JSON.stringify(payload));
        const bad = harness();
        expect(await bad.run(["spawn", "--run-dir", dir, "--payload", file])).toBe(1);
        expect(bad.opened).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wait and result require a dispatch id; cancel may target a dispatch or the whole run", async () => {
    const h = harness();
    expect(await h.run(["wait", "--run-dir", "/tmp/r"])).toBe(1);
    expect(await h.run(["result", "--run-dir", "/tmp/r"])).toBe(1);
    expect(await h.run(["cancel", "--run-dir", "/tmp/r", "--reason", "operator stop"])).toBe(0);
    expect((h.controller as ReturnType<typeof controller>).calls).toEqual([["cancel", { dispatchId: undefined, reason: "operator stop" }]]);
  });

  test("unknown commands/options fail closed and factory errors are reported", async () => {
    const h = harness();
    expect(await h.run(["launch", "--run-dir", "/tmp/r"])).toBe(1);
    expect(await h.run(["status", "--run-dir", "/tmp/r", "--surprise"])).toBe(1);

    const unavailable: ReviewAgentCliFactory = { open: async () => { throw new Error("Review agent runtime adapter unavailable"); } };
    const errors: string[] = [];
    expect(await runReviewAgentsCommand(["status", "--run-dir", "/tmp/r"], { factory: unavailable, log: () => {}, error: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("\n")).toContain("runtime adapter unavailable");
  });

  test("the production factory opens durable state with explicit host authority", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-agents-cli-controller-"));
    try {
      await ReviewAgentController.create({
        storageDir: dir,
        runId: "cli-run",
        revision: "abc123",
        config: createLargeReviewConfig(),
        adapters: [],
        authority: { authorize: () => true },
        ownerId: "creator",
      });
      const out: string[] = [];
      const factory = createReviewAgentCliFactory({ adapters: [], authority: { authorize: () => false } });
      const liveController = await factory.open(dir);
      expect(liveController).toBe(await factory.open(dir));
      expect(await runReviewAgentsCommand(["status", "--run-dir", dir], { factory, log: (line) => out.push(line), error: () => {} })).toBe(0);
      expect(JSON.parse(out[0]!).runId).toBe("cli-run");

      const payload = path.join(dir, "spawn.json");
      writeFileSync(payload, JSON.stringify({ version: 1, taskId: "t", attempt: 1, entity: "review-worker", role: "worker", adapterId: "native", scopeIds: [] }));
      const errors: string[] = [];
      const spawnOut: string[] = [];
      expect(await runReviewAgentsCommand(["spawn", "--run-dir", dir, "--payload", payload], { factory, log: (line) => spawnOut.push(line), error: (line) => errors.push(line) })).toBe(1);
      // Admission refusals retain their structured result and fail the shell command.
      expect(errors).toEqual([]);
      expect(JSON.parse(spawnOut[0]!)).toMatchObject({ ok: false, code: "run_closed" });
      await liveController.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("start cannot exceed the config ceiling injected by the host", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-agents-cli-ceiling-"));
    try {
      const ceiling = createLargeReviewConfig({ allowedAdapters: ["native"], allowedEntities: ["review-worker"], allowedSkills: ["review-logic"], fallbackPolicy: "refuse", costMode: "cost-unknown" });
      const requested = { ...ceiling, runCeilings: { ...ceiling.runCeilings, maxLaunches: ceiling.runCeilings.maxLaunches + 1 } };
      const configFile = path.join(root, "config.json");
      writeFileSync(configFile, JSON.stringify(requested));
      const factory = createReviewAgentCliFactory({ adapters: [], authority: { authorize: () => false }, configCeiling: ceiling, ownerId: "cli-test" });
      const errors: string[] = [];
      expect(await runReviewAgentsCommand(["start", "--run-dir", path.join(root, "run"), "--run-id", "r", "--revision", "abc", "--config", configFile], { factory, log: () => {}, error: (line) => errors.push(line) })).toBe(1);
      expect(errors.join("\n")).toContain("maxLaunches exceeds host ceiling");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an external CLI uses only its scoped host bridge and cannot switch run directories", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "review-agents-cli-bridge-"));
    const other = mkdtempSync(path.join(tmpdir(), "review-agents-cli-other-"));
    const requests: unknown[] = [];
    const token = "scoped-review-agents-token-0123456789abcdef";
    const server = await startExternalBridgeSocketServer({
      runDir: root,
      bridge: {
        invoke: async (receivedToken, request) => {
          requests.push({ receivedToken, request });
          return { ok: true, value: { ok: true, dispatchId: "child-1", reused: false } };
        },
      },
    });
    try {
      const payload = path.join(root, "spawn.json");
      writeFileSync(payload, JSON.stringify({ version: 1, taskId: "child-task", attempt: 1, entity: "review-worker", role: "worker", adapterId: "native", scopeIds: ["scope-1"] }));
      const factory = reviewAgentsCliFactoryFromEnv(server.envFor(token));
      const out: string[] = [];
      expect(await runReviewAgentsCommand(["spawn", "--run-dir", root, "--payload", payload], { factory, log: (line) => out.push(line), error: () => {} })).toBe(0);
      expect(JSON.parse(out[0]!)).toEqual({ ok: true, dispatchId: "child-1", reused: false });
      expect(requests).toEqual([{
        receivedToken: token,
        request: {
          operation: "spawn",
          input: { taskId: "child-task", attempt: 1, entity: "review-worker", role: "worker", adapterId: "native", scopeIds: ["scope-1"] },
        },
      }]);

      const errors: string[] = [];
      expect(await runReviewAgentsCommand(["capabilities", "--run-dir", other], { factory, log: () => {}, error: (line) => errors.push(line) })).toBe(1);
      expect(errors.join("\n")).toContain("does not match the scoped review agents bridge grant");
      expect(requests).toHaveLength(1);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a partial bridge environment fails closed", async () => {
    const factory = reviewAgentsCliFactoryFromEnv({ KERYX_REVIEW_AGENTS_BRIDGE_SOCKET: "/tmp/missing.sock" });
    const errors: string[] = [];
    expect(await runReviewAgentsCommand(["status", "--run-dir", "/tmp/review-agents"], { factory, log: () => {}, error: (line) => errors.push(line) })).toBe(1);
    expect(errors.join("\n")).toContain("bridge environment is incomplete");
  });

  test("a root terminal environment selects the full host factory and cannot mix with a descendant grant", () => {
    const runsRoot = mkdtempSync(path.join(tmpdir(), "review-agents-root-runs-"));
    const rootEnvironment = {
      KERYX_REVIEW_AGENTS_ROOT_SOCKET: "/tmp/review-agents-root.sock",
      KERYX_REVIEW_AGENTS_ROOT_TOKEN: "root-review-agents-token-0123456789abcdef",
      KERYX_REVIEW_AGENTS_ROOT_RUNS_ROOT: runsRoot,
    };
    try {
      const factory = reviewAgentsCliFactoryFromEnv(rootEnvironment);
      expect(factory.create).toBeFunction();
      expect(factory.registerPlan).toBeFunction();
      expect(() => reviewAgentsCliFactoryFromEnv({ KERYX_REVIEW_AGENTS_ROOT_SOCKET: "/tmp/review-agents-root.sock" })).toThrow("root environment is incomplete");
      expect(() => reviewAgentsCliFactoryFromEnv({ KERYX_REVIEW_AGENTS_ROOT_RUNS_ROOT: runsRoot })).toThrow("root environment is incomplete");
      expect(() => reviewAgentsCliFactoryFromEnv({
        ...rootEnvironment,
        KERYX_REVIEW_AGENTS_BRIDGE_SOCKET: "/tmp/review-agents-child.sock",
        KERYX_REVIEW_AGENTS_BRIDGE_TOKEN: "child-review-agents-token-0123456789abcdef",
        KERYX_REVIEW_AGENTS_BRIDGE_RUN_DIR: "/tmp/review-agents-run",
      })).toThrow("cannot be combined");
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});
