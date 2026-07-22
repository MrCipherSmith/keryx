// Tests for FI-02 (flow 014, W11 / T7): completion parity — the
// single-coordinator invariant, end to end.
//
// Pins the frozen contract per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R09_SINGLE_COORDINATOR       "Advance managed flow only through
//     Task Manager" — the harness completion-gate and the Task Manager task
//     it drove (via FI-01's `ManagedFlowPort`) must agree; the Task Manager
//     is proven to be the *only* path that mutates flow state (a spy
//     `FlowService` records exactly one `taskDone` call and nothing else).
//   - @SC_R09_TASK_MANAGER_MIGRATION   "Migrate Task Manager task state
//     before flow integration" — a pre-W2 schemaVersion:1 flow migrates
//     deterministically (two independent reads are identical) before
//     `completeFromGate` runs.
//   - @SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED "Prevent direct flow file
//     mutation" — `parity.ts` is proven to never touch the flow-file writer
//     internals directly (grepped in the dispatch's VERIFY step); this file
//     only ever asks the real `FlowService` / the FI-01 port to mutate state.
//
// Deterministic: gate fixtures use a fixed clock/id source (no `Date.now()`,
// `Math.random()`, or network). The integration tests use a real temp-dir
// flow (mirrors `src/harness/flow/managed-flow-port.test.ts` fixture style)
// built via `init -> freeze -> start -> taskAdd`.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchema } from "../../contracts/validator";
import { createFlowService } from "../../flow/service";
import { flowsRoot } from "../../flow/store";
import type { FlowService, FlowServiceDeps, FlowState, FlowTask, TaskRunLink } from "../../flow/types";
import { evaluateCompletion } from "../completion/gate";
import type { CompletionGateResult, CompletionInput } from "../completion/gate";
import { createTaskManagerFlowPort } from "./managed-flow-port";
import { completionParity, isFailureDisposition } from "./parity";

// Frozen schemas dir, computed relative to this file
// (src/harness/flow/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

// ---------------------------------------------------------------------------
// Gate fixtures — genuine `CompletionGateResult` values built via the real
// `evaluateCompletion`, not ad-hoc shapes.
// ---------------------------------------------------------------------------

function makeGateDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `gate-${counter++}`,
  };
}

function baseCompletionInput(runId: string, over: Partial<CompletionInput> = {}): CompletionInput {
  return {
    runId,
    requiredGates: [{ name: "tests", status: "pass" }],
    requiredEvidenceRefs: ["evidence-tests-1"],
    presentEvidenceIds: ["evidence-tests-1"],
    undisposedBlockerIds: [],
    finalMessageEmitted: true,
    ...over,
  };
}

function passGate(runId: string): CompletionGateResult {
  return evaluateCompletion(baseCompletionInput(runId), makeGateDeps());
}

function failGate(runId: string): CompletionGateResult {
  return evaluateCompletion(
    baseCompletionInput(runId, { requiredGates: [{ name: "tests", status: "fail" }] }),
    makeGateDeps(),
  );
}

function blockedGate(runId: string): CompletionGateResult {
  return evaluateCompletion(
    baseCompletionInput(runId, { undisposedBlockerIds: ["blocker-1"] }),
    makeGateDeps(),
  );
}

function runLink(): TaskRunLink {
  return { runId: "run-1", sessionId: "session-1", attempt: 1, at: "2026-01-01T00:00:00.000Z" };
}

function baseTask(over: Partial<FlowTask> = {}): FlowTask {
  return {
    id: "T5",
    title: "Fixture task",
    kind: "implement",
    status: "todo",
    ...over,
  };
}

// --- 1. Parity — pass --------------------------------------------------------

describe("completionParity — gate status 'pass'", () => {
  test("a pass gate + a done/completed task is consistent", () => {
    const gate = passGate("run-parity-pass-1");
    const task = baseTask({ status: "done", disposition: "completed" });

    const result = completionParity(task, gate);

    expect(result).toEqual({ consistent: true });
  });

  test("a pass gate + a task NOT completed is inconsistent, with a reason", () => {
    const gate = passGate("run-parity-pass-2");
    const task = baseTask({ status: "in-progress" });

    const result = completionParity(task, gate);

    expect(result.consistent).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("pass");
  });

  test("a pass gate + a done task without a 'completed' disposition is inconsistent", () => {
    const gate = passGate("run-parity-pass-3");
    const task = baseTask({ status: "done", disposition: "blocked" });

    const result = completionParity(task, gate);

    expect(result.consistent).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

// --- 2. Parity — fail (failure-disposition) ----------------------------------
//
// The key safety assertion: a failing gate must NEVER coincide with a
// "completed" task.

describe("completionParity — gate status 'fail' (failure-disposition)", () => {
  test("a fail gate + task disposition 'failed' is consistent", () => {
    const gate = failGate("run-parity-fail-1");
    const task = baseTask({ status: "done", disposition: "failed" });

    const result = completionParity(task, gate);

    expect(result).toEqual({ consistent: true });
  });

  test("a fail gate + task disposition 'completed' is inconsistent — a failing gate must never yield a completed task", () => {
    const gate = failGate("run-parity-fail-2");
    const task = baseTask({ status: "done", disposition: "completed" });

    const result = completionParity(task, gate);

    expect(result.consistent).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("fail");
  });
});

// --- 3. Parity — blocked ------------------------------------------------------

describe("completionParity — gate status 'blocked' (undisposed blocker)", () => {
  test("a blocked gate + task disposition 'blocked' is consistent", () => {
    const gate = blockedGate("run-parity-blocked-1");
    const task = baseTask({ status: "done", disposition: "blocked" });

    const result = completionParity(task, gate);

    expect(result).toEqual({ consistent: true });
  });

  test("a blocked gate + task disposition 'completed' is inconsistent", () => {
    const gate = blockedGate("run-parity-blocked-2");
    const task = baseTask({ status: "done", disposition: "completed" });

    const result = completionParity(task, gate);

    expect(result.consistent).toBe(false);
  });

  test("a blocked gate + a task not yet disposed 'blocked' is inconsistent", () => {
    const gate = blockedGate("run-parity-blocked-3");
    const task = baseTask({ status: "in-progress" });

    const result = completionParity(task, gate);

    expect(result.consistent).toBe(false);
  });
});

// --- isFailureDisposition -----------------------------------------------------

describe("isFailureDisposition — gate fail/undisposed-blocker maps to true", () => {
  test("a pass gate is not a failure disposition", () => {
    expect(isFailureDisposition(passGate("run-fd-1"))).toBe(false);
  });

  test("a fail gate is a failure disposition", () => {
    expect(isFailureDisposition(failGate("run-fd-2"))).toBe(true);
  });

  test("a blocked (undisposed-blocker) gate is a failure disposition", () => {
    expect(isFailureDisposition(blockedGate("run-fd-3"))).toBe(true);
  });
});

// --- schema validity -----------------------------------------------------------

describe("gate schema validity — parity consumes real harness artifacts", () => {
  test("every gate fixture used above validates against completion-gate-result.schema.json", () => {
    for (const gate of [passGate("run-schema-1"), failGate("run-schema-2"), blockedGate("run-schema-3")]) {
      const result = validateAgainstSchema("completion-gate-result.schema.json", gate, { schemaDir: SCHEMA_DIR });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });
});

// --- Real FlowService integration (single coordinator + failure-disposition) -
//
// Builds a genuine managed flow via the real W2 `FlowService` in a temp dir
// (init -> freeze -> start -> taskAdd), mirroring the fixture style of
// `managed-flow-port.test.ts`. Proves the port advances a REAL flow.json
// exclusively through `FlowService.taskDone`, and that reading the resulting
// task back is consistent with the gate that drove it.

let ROOT = "";

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-harness-flow-parity-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

function makeServiceDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-12T00:00:00Z"),
    ...over,
  };
}

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  const file = path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md");
  await writeFile(
    file,
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

async function buildManagedFlow(): Promise<{ service: FlowService; flowId: string; taskId: string }> {
  await fresh();
  const service = createFlowService(makeServiceDeps());
  const { flow, dir } = await service.init({ cwd: ROOT, title: "FI-02 parity integration fixture" });
  await writeAc(path.basename(dir), ["Harness completion-gate parity with Task Manager task"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  const added = await service.taskAdd({ cwd: ROOT, id: flow.id, title: "Parity integration task", kind: "implement" });
  const task = added.tasks.find((item) => item.title === "Parity integration task");
  if (!task) {
    throw new Error("expected the added task to be present on the flow");
  }
  return { service, flowId: flow.id, taskId: task.id };
}

describe("SC_R09_SINGLE_COORDINATOR (integration) — Task Manager task agrees with the pass gate that drove it", () => {
  test("completeFromGate through the real FlowService produces a task consistent with the pass gate, read back via service.get", async () => {
    const { service, flowId, taskId } = await buildManagedFlow();
    const gate = passGate("run-integration-pass-1");
    const port = createTaskManagerFlowPort(service);

    await port.completeFromGate({
      cwd: ROOT,
      flowId,
      taskId,
      gate,
      evidenceRefs: ["evidence-tests-1"],
      runLink: runLink(),
    });

    const persisted = await service.get({ cwd: ROOT, id: flowId });
    const persistedTask = persisted.tasks.find((item) => item.id === taskId);
    if (!persistedTask) {
      throw new Error("expected the persisted task to be present");
    }

    const parity = completionParity(persistedTask, gate);
    expect(parity.consistent).toBe(true);
    expect(persistedTask.status).toBe("done");
    expect(persistedTask.disposition).toBe("completed");
  });
});

describe("failure-disposition (integration) — a failing gate persists disposition 'failed', never 'completed'", () => {
  test("completeFromGate through the real FlowService with a fail gate persists disposition 'failed'", async () => {
    const { service, flowId, taskId } = await buildManagedFlow();
    const gate = failGate("run-integration-fail-1");
    const port = createTaskManagerFlowPort(service);

    expect(isFailureDisposition(gate)).toBe(true);

    await port.completeFromGate({
      cwd: ROOT,
      flowId,
      taskId,
      gate,
      evidenceRefs: ["evidence-tests-1"],
      runLink: runLink(),
    });

    const persisted = await service.get({ cwd: ROOT, id: flowId });
    const persistedTask = persisted.tasks.find((item) => item.id === taskId);
    if (!persistedTask) {
      throw new Error("expected the persisted task to be present");
    }

    expect(persistedTask.disposition).toBe("failed");
    expect(persistedTask.disposition).not.toBe("completed");

    const parity = completionParity(persistedTask, gate);
    expect(parity.consistent).toBe(true);
  });
});

// --- No duplicate coordinator --------------------------------------------------
//
// A spy `FlowService` where every method except `taskDone` throws
// immediately if called, proving `completeFromGate` triggers EXACTLY one
// `taskDone` call and no other state-mutating call — there is no second
// coordinator/loop authority.

interface RecordedCall {
  method: string;
}

function notImplemented<K extends keyof FlowService>(method: K, calls: RecordedCall[]): FlowService[K] {
  return (async (...args: unknown[]) => {
    void args;
    calls.push({ method });
    throw new Error(`unexpected call to FlowService.${method}`);
  }) as FlowService[K];
}

function fabricatedFlowState(taskId: string): FlowState {
  return {
    schemaVersion: 2,
    id: "001",
    slug: "spy-flow",
    title: "Spy flow",
    status: "in-progress",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "description", ref: null },
    acChecksum: null,
    acConfirmed: {},
    pr: { url: null },
    tasks: [
      {
        id: taskId,
        title: "Spy task",
        kind: "implement",
        status: "done",
        disposition: "completed",
        evidenceRefs: ["evidence-tests-1"],
        runLink: runLink(),
      },
    ],
    history: [],
  };
}

describe("no duplicate coordinator — completeFromGate calls exactly one state-mutating method", () => {
  test("only service.taskDone is invoked; every other FlowService method is untouched", async () => {
    const calls: RecordedCall[] = [];
    const taskDone = (async () => {
      calls.push({ method: "taskDone" });
      return fabricatedFlowState("T5");
    }) as FlowService["taskDone"];

    const service: FlowService = {
      init: notImplemented("init", calls),
      list: notImplemented("list", calls),
      get: notImplemented("get", calls),
      freeze: notImplemented("freeze", calls),
      start: notImplemented("start", calls),
      taskAdd: notImplemented("taskAdd", calls),
      taskDone,
      acConfirm: notImplemented("acConfirm", calls),
      acUpdate: notImplemented("acUpdate", calls),
      implemented: notImplemented("implemented", calls),
      complete: notImplemented("complete", calls),
      block: notImplemented("block", calls),
      unblock: notImplemented("unblock", calls),
      check: notImplemented("check", calls),
      renumber: notImplemented("renumber", calls),
    };

    const port = createTaskManagerFlowPort(service);
    const gate = passGate("run-single-coordinator-1");

    const result = await port.completeFromGate({
      cwd: "/does/not/matter",
      flowId: "001",
      taskId: "T5",
      gate,
      evidenceRefs: ["evidence-tests-1"],
      runLink: runLink(),
    });

    expect(calls).toEqual([{ method: "taskDone" }]);
    const task = result.tasks.find((item) => item.id === "T5");
    if (!task) {
      throw new Error("expected the spy-produced task to be present");
    }
    expect(completionParity(task, gate).consistent).toBe(true);
  });
});

// --- SC_R09_TASK_MANAGER_MIGRATION ---------------------------------------------

describe("SC_R09_TASK_MANAGER_MIGRATION — deterministic migration before completeFromGate", () => {
  test("a schemaVersion:1 flow migrates deterministically (two loads identical) before completeFromGate, and the result is parity-consistent", async () => {
    await fresh();
    const dirName = "001-2026-07-01-legacy-managed-flow";
    const flowDir = path.join(flowsRoot(ROOT), dirName);
    await mkdir(flowDir, { recursive: true });
    const rawFlow = {
      schemaVersion: 1,
      id: "001",
      slug: "legacy-managed-flow",
      title: "Legacy managed flow (pre-W2)",
      status: "in-progress",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      source: { type: "description", ref: null },
      acChecksum: null,
      acConfirmed: {},
      pr: { url: null },
      tasks: [
        { id: "T1", title: "Collect remaining context", kind: "context", status: "done" },
        { id: "T2", title: "Implement per plan", kind: "implement", status: "in-progress" },
      ],
      history: [{ at: "2026-07-01T00:00:00.000Z", event: "created" }],
    };
    await writeFile(path.join(flowDir, "flow.json"), `${JSON.stringify(rawFlow, null, 2)}\n`, "utf8");
    for (const file of ["description.md", "context.md", "plan.md", "tasks.md", "acceptance-criteria.md", "journal.md"]) {
      await writeFile(path.join(flowDir, file), `# ${file}\n`, "utf8");
    }

    const service = createFlowService(makeServiceDeps());

    // Two independent reads of the same on-disk v1 flow migrate to
    // byte-identical v2 in-memory states (deterministic; no write occurs).
    const load1 = await service.get({ cwd: ROOT, id: "001" });
    const load2 = await service.get({ cwd: ROOT, id: "001" });
    expect(load1).toEqual(load2);
    expect(load1.schemaVersion).toBe(2);

    const legacyTask = load1.tasks.find((item) => item.id === "T2");
    expect(legacyTask?.status).toBe("in-progress"); // legacy status remains readable

    const gate = passGate("run-migration-parity-1");
    const port = createTaskManagerFlowPort(service);
    await port.completeFromGate({
      cwd: ROOT,
      flowId: "001",
      taskId: "T2",
      gate,
      evidenceRefs: ["evidence-tests-1"],
      runLink: runLink(),
    });

    const persisted = await service.get({ cwd: ROOT, id: "001" });
    const persistedTask = persisted.tasks.find((item) => item.id === "T2");
    if (!persistedTask) {
      throw new Error("expected the migrated task to be present");
    }

    expect(persistedTask.status).toBe("done");
    expect(persistedTask.disposition).toBe("completed");
    expect(completionParity(persistedTask, gate).consistent).toBe(true);
  });
});
