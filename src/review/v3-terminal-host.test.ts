import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ProviderPort } from "../harness/provider/types";
import type { ReviewV3Host } from "./v3-host";
import { createReviewPlan, createReviewRuntimePlanRegistration, type ReviewPlanInput } from "./v3-planning";
import {
  createReviewV3TerminalCliFactory,
  createReviewV3TerminalClient,
  REVIEW_V3_ROOT_RUNS_ROOT_ENV,
  REVIEW_V3_ROOT_SOCKET_ENV,
  REVIEW_V3_ROOT_TOKEN_ENV,
  startReviewV3TerminalHost,
} from "./v3-terminal-host";

const provider = {} as ProviderPort;

function tool(name: string, invoke: InteractiveTool["invoke"]): InteractiveTool {
  return {
    definition: { name, description: name, risk: "read", inputSchema: { type: "object" } },
    invoke,
  };
}

function fakeHost(calls: Array<{ name: string; input: Record<string, unknown> }>): ReviewV3Host {
  return {
    tools: () => ["start", "plan", "spawn", "status", "wait", "result", "cancel"].map((operation) =>
      tool(`review_v3_${operation}`, async (input) => {
        calls.push({ name: operation, input });
        if (operation === "spawn") return { output: JSON.stringify({ ok: true, dispatchId: "d-1", reused: false }), isError: false };
        if (operation === "start") return { output: JSON.stringify({ operation, input, config: { costMode: "cost-unknown" } }), isError: false };
        if (operation === "plan") {
          const rawWaves = input.waves as Array<{ wave_id: string; review_round: number; assignment_ids: string[] }>;
          const registration = createReviewRuntimePlanRegistration(createReviewPlan(input.plan as ReviewPlanInput), rawWaves.map((wave) => ({
            waveId: wave.wave_id, reviewRound: wave.review_round, assignmentIds: wave.assignment_ids,
          })));
          return { output: JSON.stringify({ planHash: registration.planHash, planVersion: registration.planVersion, revision: registration.revision, waves: registration.waves }), isError: false };
        }
        return { output: JSON.stringify({ operation, input }), isError: false };
      })),
    controller: async () => ({ capabilities: (adapterId?: string) => ({ adapterId, root: true }) }) as never,
    close: async () => ({ stopped: true, activeRunIds: [] }),
  };
}

describe("Review V3 terminal root host", () => {
  test("uses an owner-only socket and refuses the wrong bearer", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "review-v3-root-test-"));
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const host = await startReviewV3TerminalHost({
      host: fakeHost(calls),
      runtime: { provider, providerId: "offline", modelId: "offline" },
      runsRoot: parent,
      tempParent: parent,
      token: "a".repeat(40),
    });
    try {
      expect((await stat(host.socketPath)).mode & 0o777).toBe(0o600);
      expect(host.env).toEqual({
        [REVIEW_V3_ROOT_SOCKET_ENV]: host.socketPath,
        [REVIEW_V3_ROOT_TOKEN_ENV]: "a".repeat(40),
        [REVIEW_V3_ROOT_RUNS_ROOT_ENV]: parent,
      });
      const wrong = createReviewV3TerminalClient({ socketPath: host.socketPath, token: "b".repeat(40) });
      await expect(wrong.invoke({ operation: "status", input: { run_id: "r-1" } })).rejects.toThrow("authorization failed");
      const rootClient = createReviewV3TerminalClient({ socketPath: host.socketPath, token: host.token });
      await expect(rootClient.invoke({ operation: "status", input: { run_id: "r-1", authority: "trust" } } as never)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    } finally {
      await host.close();
    }
  });

  test("maps the ordinary CLI factory onto the shared root host tools", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "review-v3-root-test-"));
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const host = await startReviewV3TerminalHost({
      host: fakeHost(calls),
      runtime: { provider, providerId: "offline", modelId: "offline" },
      runsRoot: parent,
      tempParent: parent,
      token: "c".repeat(40),
    });
    try {
      const client = createReviewV3TerminalClient({ socketPath: host.socketPath, token: host.token });
      const factory = createReviewV3TerminalCliFactory(client, { runsRoot: parent });
      const runDir = path.join(parent, "run-1");
      const controller = await factory.create!(runDir, {
        runId: "run-1",
        revision: "deadbeef",
        config: { costMode: "cost-unknown" } as never,
      });
      expect(await controller.capabilities("native")).toEqual({ adapterId: "native", root: true });
      expect(await controller.spawn({
        taskId: "t-1", attempt: 1, idempotencyKey: "retry-t-1", entity: "review-worker", role: "worker", adapterId: "native", scopeIds: ["src"],
      })).toEqual({ ok: true, dispatchId: "d-1", reused: false });
      await factory.registerPlan!(runDir, {
        plan: {
          revision: "deadbeef", planVersion: 1,
          areas: [{ id: "core", title: "Core", requiredAspects: ["logic"], ownerAssignmentId: "worker-1" }],
          boundaries: [],
          assignments: [{
            id: "worker-1", agentInstanceId: "agent-1", kind: "worker", entity: "review-worker",
            areaIds: ["core"], scopeIds: ["src"], coverage: [{ areaId: "core", scopeId: "src", aspect: "logic" }],
          }],
        },
        waves: [{ waveId: "wave-1", reviewRound: 1, assignmentIds: ["worker-1"] }],
      });
      expect(calls.map((call) => call.name)).toEqual(["start", "spawn", "plan"]);
      expect(calls[1]?.input).toEqual({
        run_id: "run-1", task_id: "t-1", attempt: 1, idempotency_key: "retry-t-1", entity: "review-worker", role: "worker", adapter_id: "native", scope_ids: ["src"],
      });
      expect(calls[2]?.input).toEqual({
        run_id: "run-1",
        plan: {
          revision: "deadbeef", planVersion: 1,
          areas: [{ id: "core", title: "Core", requiredAspects: ["logic"], ownerAssignmentId: "worker-1" }],
          boundaries: [],
          assignments: [{
            id: "worker-1", agentInstanceId: "agent-1", kind: "worker", entity: "review-worker",
            areaIds: ["core"], scopeIds: ["src"], coverage: [{ areaId: "core", scopeId: "src", aspect: "logic" }],
          }],
        },
        waves: [{ wave_id: "wave-1", review_round: 1, assignment_ids: ["worker-1"] }],
      });
    } finally {
      await host.close();
    }
  });

  test("binds run directories and requested configuration to this controller", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "review-v3-root-test-"));
    const other = await mkdtemp(path.join(tmpdir(), "review-v3-other-test-"));
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const host = await startReviewV3TerminalHost({
      host: fakeHost(calls),
      runtime: { provider, providerId: "offline", modelId: "offline" },
      runsRoot: parent,
      tempParent: parent,
      token: "d".repeat(40),
    });
    try {
      const client = createReviewV3TerminalClient({ socketPath: host.socketPath, token: host.token });
      const factory = createReviewV3TerminalCliFactory(client, { runsRoot: parent });
      await expect(factory.open(path.join(other, "run-1"))).rejects.toThrow("bound Review V3 runs root");
      await symlink(other, path.join(parent, "linked-run"));
      await expect(factory.open(path.join(parent, "linked-run"))).rejects.toThrow("must not be a symlink");
      await expect(client.invoke({ operation: "status", input: { run_id: "linked-run" } })).rejects.toThrow("host invocation failed");
      await expect(factory.create!(path.join(parent, "run-2"), {
        runId: "run-2",
        revision: "deadbeef",
        config: { costMode: "cost-unknown", profile: "not-the-host-profile" } as never,
      })).rejects.toThrow("does not match the controller host configuration");
      expect(calls.map((call) => call.name)).toEqual(["start", "cancel"]);
    } finally {
      await host.close();
    }
  });

  test("preserves shutdown evidence and retries a host that did not stop", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "review-v3-root-test-"));
    let closes = 0;
    const base = fakeHost([]);
    const terminal = await startReviewV3TerminalHost({
      host: {
        ...base,
        close: async () => {
          closes += 1;
          return closes === 1
            ? { stopped: false, activeRunIds: ["run-still-active"] }
            : { stopped: true, activeRunIds: [] };
        },
      },
      runtime: { provider, providerId: "offline", modelId: "offline" },
      runsRoot: parent,
      tempParent: parent,
      token: "e".repeat(40),
    });
    expect(await terminal.close()).toEqual({ stopped: false, activeRunIds: ["run-still-active"] });
    expect(await terminal.close()).toEqual({ stopped: true, activeRunIds: [] });
    expect(await terminal.close()).toEqual({ stopped: true, activeRunIds: [] });
    expect(closes).toBe(2);
  });
});
