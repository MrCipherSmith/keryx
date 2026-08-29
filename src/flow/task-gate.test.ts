// Flow 201 — the task gate (AC1, AC2, AC3).
//
// `taskGateStatus()` shipped in machine.ts written, tested and unwired. The
// measured consequence: 24 of 184 completed flow packages carry an unfinished
// task (34 tasks between them, 24 of which are the review step itself). These
// tests exercise the gate through `service.complete()` end to end — the whole
// point of the flow is that a property asserted only in prose blocks nothing,
// so asserting it only by inspection would repeat the defect.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { evaluateTaskGate } from "./machine";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-08-29T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-task-gate-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

function flowJsonPath(dir: string): string {
  return path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
}

async function readRawFlow(dir: string): Promise<FlowState> {
  return JSON.parse(await readFile(flowJsonPath(dir), "utf8")) as FlowState;
}

async function writeRawFlow(dir: string, flow: FlowState): Promise<void> {
  await writeFile(flowJsonPath(dir), `${JSON.stringify(flow, null, 2)}\n`, "utf8");
}

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

/** Drive a fresh flow to the point where `complete` runs its gates. */
async function driveToGates(
  service: FlowService,
  title: string,
): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  return { id: flow.id, dir };
}

// --- AC1: one open task fails `complete` -----------------------------------

test("AC1 — a flow with one open task fails `complete` and returns to in-progress", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Gate on an open task");

  // Close every scaffolded task except T4 (the review step — the exact task
  // that leaked in 24 of the 24 historical packages).
  for (const taskId of ["T1", "T2", "T3"]) {
    await service.taskDone({ cwd: ROOT, id, taskId });
  }

  const result = await service.complete({ cwd: ROOT, id });

  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
  const tasks = result.gates.find((gate) => gate.name === "tasks");
  expect(tasks?.status).toBe("fail");
  expect(tasks?.detail).toContain("not done: T4");
});

test("AC1 — the same flow passes once the last task is closed", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Gate satisfied");

  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id, taskId });
  }

  const result = await service.complete({ cwd: ROOT, id });

  expect(result.gates.find((gate) => gate.name === "tasks")?.status).toBe("pass");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
});

test("AC1 — a task closed with disposition 'failed' fails the gate", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Explicit failure");

  await service.taskDone({ cwd: ROOT, id, taskId: "T1" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T2", disposition: "failed" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T3" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T4" });

  const result = await service.complete({ cwd: ROOT, id });
  const tasks = result.gates.find((gate) => gate.name === "tasks");
  expect(tasks?.status).toBe("fail");
  expect(tasks?.detail).toContain("failed: T2");
});

// --- AC2: a pre-existing package is not retroactively invalidated ----------

test("AC2 — a pre-existing package (no gates.tasks) is unaffected: the gate is skipped, not failed", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, "Legacy package");

  // Reproduce a package written before the gate existed. Every one of the 24
  // real packages is already `schemaVersion: 2` on disk (read-time migration
  // persists v2 on the next mutation), so the version cannot be the
  // discriminator — the ABSENCE of `gates` is.
  const raw = await readRawFlow(dir);
  expect(raw.schemaVersion).toBe(2);
  delete raw.gates;
  await writeRawFlow(dir, raw);
  // T1-T4 are left `todo`, exactly like the historical leak.

  const result = await service.complete({ cwd: ROOT, id });

  const tasks = result.gates.find((gate) => gate.name === "tasks");
  expect(tasks?.status).toBe("skipped");
  expect(tasks?.detail).toContain("created before the gate");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
});

test("AC2 — `flow init` opts new packages in, so the gate is never dead for new work", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Opt-in on creation" });
  expect(flow.gates?.tasks).toBe(true);
  // Persisted, not just returned in memory.
  const raw = await readRawFlow(path.basename(created));
  expect(raw.gates?.tasks).toBe(true);
});

// --- AC3: the `skipped` disposition ---------------------------------------

test("AC3 — a task skipped WITHOUT a recorded reason fails the gate", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Unreasoned skip");

  await service.taskDone({ cwd: ROOT, id, taskId: "T1" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T2" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T3" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T4", disposition: "skipped" });

  const result = await service.complete({ cwd: ROOT, id });
  const tasks = result.gates.find((gate) => gate.name === "tasks");
  expect(tasks?.status).toBe("fail");
  expect(tasks?.detail).toContain("skipped without a recorded reason: T4");
  expect(result.passed).toBe(false);
});

test("AC3 — a task skipped WITH a recorded reason passes the gate, and the reason is persisted", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, "Reasoned skip");

  await service.taskDone({ cwd: ROOT, id, taskId: "T1" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T2" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T3" });
  await service.taskDone({
    cwd: ROOT,
    id,
    taskId: "T4",
    disposition: "skipped",
    reason: "no reviewable diff: the change was reverted in full",
  });

  const raw = await readRawFlow(dir);
  const t4 = raw.tasks.find((task) => task.id === "T4");
  expect(t4?.disposition).toBe("skipped");
  expect(t4?.dispositionReason).toBe("no reviewable diff: the change was reverted in full");

  const result = await service.complete({ cwd: ROOT, id });
  expect(result.gates.find((gate) => gate.name === "tasks")?.status).toBe("pass");
  expect(result.passed).toBe(true);
});

test("AC3 — a whitespace-only reason does not count as a recorded reason", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Whitespace skip");

  for (const taskId of ["T1", "T2", "T3"]) {
    await service.taskDone({ cwd: ROOT, id, taskId });
  }
  await service.taskDone({ cwd: ROOT, id, taskId: "T4", disposition: "skipped", reason: "   " });

  const result = await service.complete({ cwd: ROOT, id });
  expect(result.gates.find((gate) => gate.name === "tasks")?.status).toBe("fail");
});

// --- The pure evaluator ----------------------------------------------------

test("evaluateTaskGate reports every failing category at once, not just the first", () => {
  const verdict = evaluateTaskGate([
    { id: "T1", title: "a", kind: "implement", status: "todo" },
    { id: "T2", title: "b", kind: "implement", status: "done", disposition: "failed" },
    { id: "T3", title: "c", kind: "review", status: "done", disposition: "skipped" },
    {
      id: "T4",
      title: "d",
      kind: "review",
      status: "done",
      disposition: "skipped",
      dispositionReason: "covered by T2",
    },
    { id: "T5", title: "e", kind: "docs", status: "done", disposition: "completed" },
    { id: "T6", title: "f", kind: "docs", status: "done", disposition: "blocked" },
  ]);

  expect(verdict.open).toEqual(["T1"]);
  expect(verdict.failed).toEqual(["T2"]);
  expect(verdict.unreasonedSkips).toEqual(["T3"]);
  expect(verdict.blocked).toEqual(["T6"]);
  expect(verdict.total).toBe(6);
  expect(verdict.passed).toBe(false);
});

test("a blocked task fails the gate — it is terminal, but the work did not happen", () => {
  // This is the bypass the first version of the gate shipped with, and it was
  // cheaper than the one the gate was written to prevent: unlike `skipped`,
  // `blocked` required no reason at all. It is also not hypothetical CLI abuse —
  // `ManagedFlowPort` maps a harness completion gate of `blocked` to this exact
  // disposition and writes it through `taskDone`.
  const verdict = evaluateTaskGate([
    { id: "T1", title: "a", kind: "implement", status: "done", disposition: "completed" },
    { id: "T2", title: "b", kind: "review", status: "done", disposition: "blocked" },
  ]);
  expect(verdict.blocked).toEqual(["T2"]);
  expect(verdict.passed).toBe(false);
});

test("a blocked task fails even when it carries a reason", () => {
  // A reason makes a skip auditable; it does not make blocked work done.
  const verdict = evaluateTaskGate([
    {
      id: "T1",
      title: "a",
      kind: "review",
      status: "done",
      disposition: "blocked",
      dispositionReason: "waiting on upstream",
    },
  ]);
  expect(verdict.blocked).toEqual(["T1"]);
  expect(verdict.passed).toBe(false);
});

test("an unrecognised disposition fails the gate rather than passing it", () => {
  // `--disposition skiped` used to reach disk verbatim, match neither the
  // `=== "failed"` nor the `=== "skipped"` check, and pass. A gate whose
  // default for the unknown case is "pass" is not a gate.
  const verdict = evaluateTaskGate([
    { id: "T1", title: "a", kind: "review", status: "done", disposition: "skiped" as never },
  ]);
  expect(verdict.unknownDisposition).toEqual(["T1"]);
  expect(verdict.passed).toBe(false);
});

test("a task appears in exactly one failure bucket", () => {
  // An unknown disposition is reported as unknown, not also as a non-skip.
  const verdict = evaluateTaskGate([
    { id: "T1", title: "a", kind: "review", status: "done", disposition: "bogus" as never },
  ]);
  expect(verdict.unknownDisposition).toEqual(["T1"]);
  expect(verdict.blocked).toEqual([]);
  expect(verdict.unreasonedSkips).toEqual([]);
  expect(verdict.failed).toEqual([]);
  expect(verdict.open).toEqual([]);
});

test("evaluateTaskGate passes an all-terminal list, including a disposition-less v1 done task", () => {
  const verdict = evaluateTaskGate([
    { id: "T1", title: "a", kind: "implement", status: "done" }, // v1: no disposition
    { id: "T2", title: "b", kind: "review", status: "done", disposition: "completed" },
  ]);
  expect(verdict.passed).toBe(true);
  expect(verdict.open).toEqual([]);
});
