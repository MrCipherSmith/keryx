// RED tests for FI-01 (flow 014, W11 / T5): the `ManagedFlowPort`.
//
// Pins the frozen contract per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R09_SINGLE_COORDINATOR         "Advance managed flow only through
//     Task Manager" — the harness maps a typed gate artifact + evidence +
//     runLink into a Task Manager `taskDone` call; flow-orchestrator/Task
//     Manager alone advances task and completion state.
//   - @SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED "Prevent direct flow file
//     mutation" — the harness never writes flow.json itself; Task Manager
//     remains the only flow-state writer.
//   - @SC_R09_TASK_MANAGER_MIGRATION     "Migrate Task Manager task state
//     before flow integration" — a pre-W2 schemaVersion:1 flow migrates
//     deterministically to v2 and still accepts `completeFromGate`.
//
// FI-01 impl (next dispatch) implements `src/harness/flow/managed-flow-port.ts`
// (`gateToDisposition`, `ManagedFlowPort`, `createTaskManagerFlowPort`) to make
// this suite GREEN; until then the missing-module import is the expected RED
// failure ("Cannot find module './managed-flow-port'").
//
// FI-01 impl also makes an ADDITIVE, backward-compatible change to
// `FlowService.taskDone`'s input (`evidenceRefs?: string[]`, `runLink?:
// TaskRunLink`) in `src/flow/types.ts` / `src/flow/service.ts` — NOT made by
// this file. Until that lands, the real-`FlowService` integration tests below
// (SC_R09_SINGLE_COORDINATOR, SC_R09_TASK_MANAGER_MIGRATION) will fail on
// assertions about `evidenceRefs`/`runLink` even after the port module
// exists; only the SPY-based tests (which don't depend on the real
// `taskDone` persisting those fields) are expected to go green from the port
// alone.
//
// Deterministic: gate/evidence fixtures use fixed clocks/ids (no
// `Date.now()`, `Math.random()`, or network). The real-`FlowService`
// integration tests use a real temp-dir flow (mirrors `src/flow/service.test.ts`
// / `src/flow/migration.test.ts` fixture style) built via `init -> freeze ->
// start -> taskAdd`.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchema } from "../../contracts/validator";
import { createFlowService } from "../../flow/service";
import { flowsRoot } from "../../flow/store";
import type {
  FlowService,
  FlowServiceDeps,
  FlowState,
  TaskDisposition,
  TaskRunLink,
} from "../../flow/types";
import { evaluateCompletion } from "../completion/gate";
import type { CompletionGateResult, CompletionInput } from "../completion/gate";
import type { EvidenceRecord } from "../evidence/types";

// PINNED API (see dispatch) — FI-01 impl exports these; import fails until
// then (expected RED: "Cannot find module './managed-flow-port'").
import { createTaskManagerFlowPort, gateToDisposition } from "./managed-flow-port";
import type { ManagedFlowPort } from "./managed-flow-port";

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

const SHA_PLACEHOLDER = "d".repeat(64);

// ---------------------------------------------------------------------------
// Gate/evidence fixtures — genuine harness artifacts (not ad-hoc shapes), so
// the port is proven to consume real `CompletionGateResult`/`EvidenceRecord`
// values (item 6 of the dispatch).
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

function evidenceRecord(evidenceId: string, runId: string): EvidenceRecord {
  return {
    schemaVersion: 1,
    evidenceId,
    causal: { runId, sessionId: "session-1", correlationId: "correlation-1" },
    kind: "test",
    artifact: { artifactId: `artifact-${evidenceId}`, kind: "test-result", hash: SHA_PLACEHOLDER },
    provenance: { provenanceId: `provenance-${evidenceId}`, trustLevel: "trusted", sourceKind: "test-runner" },
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}

function runLink(): TaskRunLink {
  return { runId: "run-1", sessionId: "session-1", attempt: 1, at: "2026-01-01T00:00:00.000Z" };
}

// --- 1. gate -> disposition mapping -----------------------------------------

describe("gateToDisposition — maps a CompletionGateResult status to a Task Manager disposition", () => {
  test("status 'pass' maps to disposition 'completed'", () => {
    const gate = passGate("run-map-1");
    expect(gate.status).toBe("pass");
    expect(gateToDisposition(gate)).toBe("completed");
  });

  test("status 'fail' maps to disposition 'failed'", () => {
    const gate = failGate("run-map-2");
    expect(gate.status).toBe("fail");
    expect(gateToDisposition(gate)).toBe("failed");
  });

  test("a gate with an undisposed blocker (status 'blocked') maps to disposition 'blocked'", () => {
    const gate = blockedGate("run-map-3");
    expect(gate.status).toBe("blocked");
    expect(gateToDisposition(gate)).toBe("blocked");
  });

  test("any other status (e.g. 'unknown') maps to disposition 'failed' — never a false completion", () => {
    // A gate whose status is neither pass/blocked/fail (here the real
    // "unknown" variant) must fall through to the safe terminal "failed".
    const gate = { ...passGate("run-map-4"), status: "unknown" } as CompletionGateResult;
    expect(gate.status).toBe("unknown");
    expect(gateToDisposition(gate)).toBe("failed");
  });

  test("decision table: pass->completed, blocked->blocked, fail->failed, other->failed", () => {
    const cases: Array<[CompletionGateResult["status"], "completed" | "blocked" | "failed"]> = [
      ["pass", "completed"],
      ["blocked", "blocked"],
      ["fail", "failed"],
      ["unknown", "failed"],
    ];
    for (const [status, expected] of cases) {
      const gate = { ...passGate(`run-table-${status}`), status } as CompletionGateResult;
      expect(gateToDisposition(gate)).toBe(expected);
    }
  });
});

// --- 6. gate/evidence artifacts are schema-valid (consumed by the port) ----

describe("gate/evidence schema validity — the port consumes real harness artifacts", () => {
  test("the CompletionGateResult passed into completeFromGate validates against completion-gate-result.schema.json", () => {
    const gate = passGate("run-schema-1");
    const result = validateAgainstSchema("completion-gate-result.schema.json", gate, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("the EvidenceRecord backing an evidenceRef validates against evidence-record.schema.json", () => {
    const record = evidenceRecord("evidence-tests-1", "run-schema-1");
    const result = validateAgainstSchema("evidence-record.schema.json", record, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// --- 3 & 4. Spy FlowService — single coordinator + no direct network -------
//
// A SPY implementing the full `FlowService` surface: every method except
// `taskDone` throws immediately if called (so a stray call surfaces as a
// hard failure, not a silently-ignored one), and `taskDone` records its
// input. This proves `completeFromGate` calls exactly `service.taskDone`
// once with the mapped args and nothing else (@SC_R09_SINGLE_COORDINATOR /
// @SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED: the harness never writes flow.json
// itself, it only ever asks the injected Task Manager service).

interface RecordedCall {
  method: string;
  args: unknown[];
}

type SpyTaskDoneInput = Parameters<FlowService["taskDone"]>[0] & {
  evidenceRefs?: string[];
  runLink?: TaskRunLink;
};

function notImplemented<K extends keyof FlowService>(method: K, calls: RecordedCall[]): FlowService[K] {
  return (async (...args: unknown[]) => {
    calls.push({ method, args });
    throw new Error(`unexpected call to FlowService.${method}`);
  }) as FlowService[K];
}

function fabricatedFlowState(taskId: string, disposition: TaskDisposition, evidenceRefs: string[], link: TaskRunLink): FlowState {
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
        disposition,
        evidenceRefs,
        runLink: link,
      },
    ],
    history: [],
  };
}

function makeSpyService(
  taskId: string,
  resultFactory: (input: SpyTaskDoneInput) => FlowState,
): { service: FlowService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const taskDone = (async (input: SpyTaskDoneInput) => {
    calls.push({ method: "taskDone", args: [input] });
    return resultFactory(input);
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
  void taskId; // taskId is threaded through resultFactory, not the spy itself.
  return { service, calls };
}

describe("SC_R09_SINGLE_COORDINATOR / SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED — single coordinator, no direct writes", () => {
  test("completeFromGate calls exactly service.taskDone once with the mapped disposition/evidenceRefs/runLink and nothing else; no direct network access", async () => {
    const link = runLink();
    const refs = ["evidence-tests-1"];
    const gate = passGate("run-spy-1");
    const { service, calls } = makeSpyService("T5", (input) =>
      fabricatedFlowState("T5", input.disposition ?? "completed", input.evidenceRefs ?? [], link),
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network access is not permitted by the ManagedFlowPort");
    }) as unknown as typeof fetch;

    try {
      const port: ManagedFlowPort = createTaskManagerFlowPort(service);
      const result: FlowState = await port.completeFromGate({
        cwd: "/does/not/matter",
        flowId: "001",
        taskId: "T5",
        gate,
        evidenceRefs: refs,
        runLink: link,
      });

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.method).toBe("taskDone");
      const input = call.args[0] as SpyTaskDoneInput;
      expect(input.cwd).toBe("/does/not/matter");
      expect(input.id).toBe("001");
      expect(input.taskId).toBe("T5");
      expect(input.disposition).toBe("completed");
      expect(input.evidenceRefs).toEqual(refs);
      expect(input.runLink).toEqual(link);

      const task = result.tasks.find((item) => item.id === "T5");
      expect(task?.disposition).toBe("completed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// --- 4. failure-disposition --------------------------------------------------

describe("failure-disposition — a failing gate never produces a false completion", () => {
  test("a status:'fail' gate maps to disposition 'failed' via the port, not 'completed'", async () => {
    const link = runLink();
    const gate = failGate("run-spy-2");
    const { service, calls } = makeSpyService("T5", (input) =>
      fabricatedFlowState("T5", input.disposition ?? "completed", input.evidenceRefs ?? [], link),
    );
    const port = createTaskManagerFlowPort(service);

    const result: FlowState = await port.completeFromGate({
      cwd: "/tmp/does-not-matter",
      flowId: "001",
      taskId: "T5",
      gate,
      evidenceRefs: ["evidence-tests-1"],
      runLink: link,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const input = call.args[0] as SpyTaskDoneInput;
    expect(input.disposition).toBe("failed");
    expect(input.disposition).not.toBe("completed");

    const task = result.tasks.find((item) => item.id === "T5");
    expect(task?.disposition).toBe("failed");
    expect(task?.disposition).not.toBe("completed");
  });
});

// --- 2 & 5. Real FlowService integration (single coordinator + migration) --
//
// Builds a genuine managed flow via the real W2 `FlowService` in a temp dir
// (init -> freeze -> start -> taskAdd), mirroring the fixture style of
// `src/flow/service.test.ts`. Proves the port advances a REAL flow.json
// exclusively through `FlowService.taskDone` (never a direct file write) and
// that the persisted result (read back via `service.get`) carries the
// disposition/evidenceRefs/runLink the port mapped from the gate.

let ROOT = "";

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-harness-flow-port-"));
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
  const { flow, dir } = await service.init({ cwd: ROOT, title: "FI-01 port integration fixture" });
  await writeAc(path.basename(dir), ["Managed flow completes only via Task Manager"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  const added = await service.taskAdd({ cwd: ROOT, id: flow.id, title: "Port integration task", kind: "implement" });
  const task = added.tasks.find((item) => item.title === "Port integration task");
  if (!task) {
    throw new Error("expected the added task to be present on the flow");
  }
  return { service, flowId: flow.id, taskId: task.id };
}

describe("SC_R09_SINGLE_COORDINATOR — advance managed flow only through Task Manager (real FlowService)", () => {
  test("completeFromGate persists task done/disposition/evidenceRefs/runLink through the real FlowService, read back via service.get", async () => {
    const { service, flowId, taskId } = await buildManagedFlow();
    const link = runLink();
    const gate = passGate("run-integration-1");
    const port = createTaskManagerFlowPort(service);

    const result: FlowState = await port.completeFromGate({
      cwd: ROOT,
      flowId,
      taskId,
      gate,
      evidenceRefs: ["evidence-tests-1"],
      runLink: link,
    });

    const task = result.tasks.find((item) => item.id === taskId);
    expect(task?.status).toBe("done");
    expect(task?.disposition).toBe("completed");
    expect(task?.evidenceRefs).toEqual(["evidence-tests-1"]);
    expect(task?.runLink).toEqual(link);

    const persisted = await service.get({ cwd: ROOT, id: flowId });
    const persistedTask = persisted.tasks.find((item) => item.id === taskId);
    expect(persistedTask?.status).toBe("done");
    expect(persistedTask?.disposition).toBe("completed");
    expect(persistedTask?.evidenceRefs).toEqual(["evidence-tests-1"]);
    expect(persistedTask?.runLink).toEqual(link);
  });
});

describe("SC_R09_TASK_MANAGER_MIGRATION — migrate Task Manager task state before flow integration", () => {
  test("a schemaVersion:1 flow migrates deterministically to v2 on read and still accepts completeFromGate through the real Task Manager", async () => {
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
    const before = await service.get({ cwd: ROOT, id: "001" });
    expect(before.schemaVersion).toBe(2); // migrated in-memory on read (TM-01 §4.1)
    const legacyTask = before.tasks.find((item) => item.id === "T2");
    expect(legacyTask?.status).toBe("in-progress"); // legacy status remains readable

    const link = runLink();
    const gate = passGate("run-migration-1");
    const port = createTaskManagerFlowPort(service);
    const result: FlowState = await port.completeFromGate({
      cwd: ROOT,
      flowId: "001",
      taskId: "T2",
      gate,
      evidenceRefs: ["evidence-tests-1"],
      runLink: link,
    });

    expect(result.schemaVersion).toBe(2);
    const migratedTask = result.tasks.find((item) => item.id === "T2");
    expect(migratedTask?.status).toBe("done");
    expect(migratedTask?.disposition).toBe("completed");
    expect(migratedTask?.evidenceRefs).toEqual(["evidence-tests-1"]);
    expect(migratedTask?.runLink).toEqual(link);

    const persisted = await service.get({ cwd: ROOT, id: "001" });
    const persistedTask = persisted.tasks.find((item) => item.id === "T2");
    expect(persistedTask?.disposition).toBe("completed");
  });
});
