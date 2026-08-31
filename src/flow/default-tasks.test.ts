// Flow 211, AC9 — the scaffold `flow init` writes, pinned.
//
// AC8 asked whether `flow init` should keep generating its four default tasks
// or stop. The decision is KEEP, and the evidence is written at the definition
// (`default-tasks.ts`). These tests exist so the decision is enforced rather
// than merely stated: each one pins a specific load-bearing claim from that
// rationale, so a future removal has to break a named assertion instead of
// quietly deleting a comment.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { DEFAULT_TASKS } from "./default-tasks";
import { evaluateTaskGate, isUntouchedScaffold, nextTask } from "./machine";
import { renderTasksDoc } from "./templates";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";

const HEAD = "beef1beef2beef3beef4beef5beef6beef7beef8";
const PR = "https://github.com/acme/app/pull/1";

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-08-31T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-default-tasks-"));
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

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

/** Drive a fresh flow to the point where `complete` runs its gates. */
async function driveToGates(service: FlowService, title: string): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: PR });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR });
  return { id: flow.id, dir };
}

// --- The set is exactly the documented set ---------------------------------

test("AC9 — `flow init` writes exactly the four documented scaffold tasks, all todo", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow, dir } = await service.init({ cwd: ROOT, title: "Scaffold shape" });

  expect(flow.tasks.map((task) => ({ id: task.id, title: task.title, kind: task.kind }))).toEqual(
    DEFAULT_TASKS.map((task) => ({ id: task.id, title: task.title, kind: task.kind })),
  );
  expect(flow.tasks).toHaveLength(4);
  expect(flow.tasks.every((task) => task.status === "todo")).toBe(true);

  // Persisted, not just returned in memory.
  const raw = JSON.parse(await readFile(flowJsonPath(path.basename(dir)), "utf8")) as FlowState;
  expect(raw.tasks.map((task) => task.title)).toEqual(DEFAULT_TASKS.map((task) => task.title));
});

test("AC9 — the package's tasks.md documents the same four rows the state carries", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow, dir } = await service.init({ cwd: ROOT, title: "Doc matches state" });

  const doc = await readFile(path.join(ROOT, dir, "tasks.md"), "utf8");
  const rows = doc
    .split("\n")
    .filter((line) => /^\|\s*T\d+\s*\|/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );

  // The regression this catches is real and was shipped: `flow.json` said
  // "Self-review and prepare draft PR" while tasks.md said "Review, fix
  // findings, and prepare PR", so every package documented a task it did not
  // contain. "The four are exactly the documented set" is only a defensible
  // reason to keep them if the document and the state actually agree.
  expect(rows).toEqual(flow.tasks.map((task) => [task.id, task.kind, task.title]));
  expect(renderTasksDoc()).toBe(doc);
});

// --- Why keeping them is not merely a preference ---------------------------

test("AC9 — an empty task list passes the gate vacuously, which is why init still writes four", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, "Empty list, gate says nothing");

  // The counterfactual, exercised rather than asserted in prose: this is
  // exactly the state every flow would be in at `complete` if `flow init`
  // stopped generating tasks and nobody added any.
  const file = flowJsonPath(dir);
  const raw = JSON.parse(await readFile(file, "utf8")) as FlowState;
  raw.tasks = [];
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  const result = await service.complete({ cwd: ROOT, id });
  const tasks = result.gates.find((gate) => gate.name === "tasks");

  expect(tasks?.status).toBe("pass");
  expect(tasks?.detail).toContain("0 task(s) terminal");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");

  // The same fact at the pure level, so the reason survives a refactor of
  // `complete`: the gate has nothing to refuse when there is nothing to check.
  expect(evaluateTaskGate([])).toMatchObject({ passed: true, total: 0, open: [] });
});

test("AC9 — init alone yields a startable task list, the only one `/goal --auto` gets", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow } = await service.init({ cwd: ROOT, title: "Auto-provisioned goal" });

  // `autoProvisionFlow` (src/commands/goal-command.ts) calls `init` and nothing
  // else — `keryx flow plan` is advisory console output that writes no state.
  // So this scaffold is the entire task list of every `--auto` flow, and it is
  // what the continuation round's steering message names each round (pinned
  // from the other side by goal-command.test.ts T9).
  expect(flow.tasks.length).toBeGreaterThan(0);
  const decision = nextTask(flow.tasks);
  expect(decision.kind).toBe("ready");
  expect(decision.kind === "ready" ? decision.task.id : null).toBe("T1");
});

// --- Controlled: marked at the source, surfaced at the gate ----------------

test("AC9 — every generated row records origin 'scaffold'; an added task does not", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow, dir } = await service.init({ cwd: ROOT, title: "Origin marker" });

  expect(flow.tasks.map((task) => task.origin)).toEqual(["scaffold", "scaffold", "scaffold", "scaffold"]);

  const after = await service.taskAdd({ cwd: ROOT, id: flow.id, title: "Operator work", kind: "implement" });
  expect(after.tasks.find((task) => task.id === "T5")?.origin).toBeUndefined();

  // Persisted, so "is this generated?" is a recorded fact rather than a title
  // match against a list that any rewording would break.
  const raw = JSON.parse(await readFile(flowJsonPath(path.basename(dir)), "utf8")) as FlowState;
  expect(raw.tasks.filter((task) => task.origin === "scaffold")).toHaveLength(4);
});

test("AC9 — `isUntouchedScaffold` reads the record, never the clock", () => {
  const scaffold = { id: "T1", title: "t", kind: "context", status: "todo", origin: "scaffold" } as const;

  expect(isUntouchedScaffold({ ...scaffold })).toBe(true);
  // Started: an attempt is on the log, so it is no longer untouched.
  expect(isUntouchedScaffold({ ...scaffold, attempts: { count: 1, log: [] } })).toBe(false);
  expect(isUntouchedScaffold({ ...scaffold, status: "in-progress" })).toBe(false);
  // Operator-authored, and pre-marker packages: absence is never read as
  // scaffold, so no historical row is accused of being generated.
  expect(isUntouchedScaffold({ ...scaffold, origin: undefined })).toBe(false);
});

test("AC9 — the gate names untouched scaffold rows and hands over the command, without closing them", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Surface, do not close");

  const result = await service.complete({ cwd: ROOT, id });
  const tasks = result.gates.find((gate) => gate.name === "tasks");

  // Surfaced...
  expect(tasks?.detail).toContain("never started since `flow init` generated them: T1, T2, T3, T4");
  expect(tasks?.detail).toContain('--disposition skipped --reason "<why this flow did not need it>"');
  // ...and still refused. Naming them changes what the operator is told, never
  // whether the gate passes.
  expect(tasks?.status).toBe("fail");
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
  const stillOpen = await service.get({ cwd: ROOT, id });
  expect(stillOpen.tasks.every((task) => task.status === "todo" && task.disposition === undefined)).toBe(true);
});

// --- No TTL: nothing expires, nothing closes itself ------------------------

test("AC9 — a year of elapsed time disposes of nothing: the scaffold still blocks completion", async () => {
  await fresh();
  // A clock that jumps a year between `init` and `complete`. If any expiry
  // existed — at read, at gate evaluation, anywhere — this is the shape that
  // would trip it. `disposition: skipped` must mean somebody judged the work
  // unnecessary; "nobody looked for a year" is the absence of that judgement,
  // not an instance of it.
  let clock = new Date("2026-08-31T10:00:00Z");
  const service = createFlowService(makeDeps({ now: () => clock }));
  const { id } = await driveToGates(service, "A year goes by");

  clock = new Date("2027-08-31T10:00:00Z");

  const result = await service.complete({ cwd: ROOT, id });
  const tasks = result.gates.find((gate) => gate.name === "tasks");

  expect(tasks?.status).toBe("fail");
  expect(tasks?.detail).toContain("not done: T1, T2, T3, T4");
  expect(result.flow.status).toBe("in-progress");

  const after = await service.get({ cwd: ROOT, id });
  expect(after.tasks.map((task) => task.status)).toEqual(["todo", "todo", "todo", "todo"]);
  expect(after.tasks.some((task) => task.disposition !== undefined)).toBe(false);
  // Nothing anywhere in the record may claim a task ended because time passed.
  expect(JSON.stringify(after)).not.toMatch(/expire|stale|timed out|ttl/i);
});

test("AC9 — every disposition reason on record was written by a caller, not generated", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Reasons are authored");

  const reason = "superseded by the explicit plan in plan.md, which completed";
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id, taskId, disposition: "skipped", reason });
  }

  const after = await service.get({ cwd: ROOT, id });
  for (const task of after.tasks) {
    // The recorded reason is verbatim what the caller passed. There is no code
    // path that supplies one, so there is no way for the record to carry a
    // reason nobody stands behind.
    expect(task.dispositionReason).toBe(reason);
  }
});

// --- Keeping them does not force a flow to work them -----------------------

test("AC9 — a flow with its own task list may skip the scaffold with a reason and still pass", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Own plan supersedes the scaffold");

  await service.taskAdd({ cwd: ROOT, id, title: "The real work", kind: "implement" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T5" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({
      cwd: ROOT,
      id,
      taskId,
      disposition: "skipped",
      reason: "superseded by T5, which completed",
    });
  }

  const result = await service.complete({ cwd: ROOT, id });

  expect(result.gates.find((gate) => gate.name === "tasks")?.status).toBe("pass");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
});

test("AC9 — but the exit is reasoned: an unreasoned scaffold skip is still refused", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Bulk-skip the scaffold");

  await service.taskAdd({ cwd: ROOT, id, title: "The real work", kind: "implement" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T5" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id, taskId, disposition: "skipped" });
  }

  const result = await service.complete({ cwd: ROOT, id });
  const tasks = result.gates.find((gate) => gate.name === "tasks");

  expect(tasks?.status).toBe("fail");
  expect(tasks?.detail).toContain("skipped without a recorded reason: T1, T2, T3, T4");
  expect(result.flow.status).toBe("in-progress");
});
