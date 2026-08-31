// Flow 209, AC6 — the two fields that were written and read by nothing.
//
// `dependsOn` was written by `flow task add --depends`, migrated by `store.ts`,
// typed in `types.ts`, and consumed by no code at all, while `flow-orchestrator`
// documented "resume at the first task not done, respecting `dependsOn` order"
// as though something computed it. `attempts.count` was worse: the incrementing
// code existed and worked, and **zero of the seven flows completed after it
// shipped ever called it** — the failure had simply moved from "nothing
// increments it" to "nothing calls the thing that increments it".
//
// So these tests drive the SERVICE and the CLI, never the pure functions alone.
// A test over `nextTask([...])` would pass identically in the release where
// nothing called `nextTask`, which is the exact shape of the defect.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { dependencyIssues, nextTask } from "./machine";
import { flowCommand } from "../commands/flow";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";
const ORIGINAL_CWD = process.cwd();
let logs: string[] = [];
const realLog = console.log;
const realError = console.error;

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: "abc1234" }),
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

async function fresh(): Promise<FlowService> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-depends-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService(makeDeps());
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

/** A flow with only the tasks this test declares, in declaration order. */
async function flowWithTasks(
  service: FlowService,
  title: string,
  tasks: Array<{ title: string; dependsOn?: string[] }>,
): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title });
  const dir = path.basename(created);
  // `init` scaffolds four default tasks; drop them so the ids the test declares
  // are T1..Tn and the assertions read as written.
  const raw = JSON.parse(await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8")) as FlowState;
  raw.tasks = [];
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "flow.json"),
    `${JSON.stringify(raw, null, 2)}\n`,
    "utf8",
  );
  for (const task of tasks) {
    await service.taskAdd({
      cwd: ROOT,
      id: flow.id,
      title: task.title,
      ...(task.dependsOn === undefined ? {} : { dependsOn: task.dependsOn }),
    });
  }
  return { id: flow.id, dir };
}

async function readRaw(dir: string): Promise<FlowState> {
  return JSON.parse(await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8")) as FlowState;
}

// ---------------------------------------------------------------------------
// `dependsOn` — read by `flow next`
// ---------------------------------------------------------------------------

test("AC6: `service.next` skips a task whose dependency is not done", async () => {
  const service = await fresh();
  const { id } = await flowWithTasks(service, "Ordered work", [
    { title: "write the spec" },
    { title: "implement it", dependsOn: ["T1"] },
  ]);

  const first = await service.next({ cwd: ROOT, id });
  expect(first.kind).toBe("ready");
  expect(first.kind === "ready" && first.task.id).toBe("T1");

  await service.taskDone({ cwd: ROOT, id, taskId: "T1" });

  const second = await service.next({ cwd: ROOT, id });
  expect(second.kind).toBe("ready");
  expect(second.kind === "ready" && second.task.id).toBe("T2");
});

test("AC6: the declared order beats list order — T2 waits even when T1 is later in the list", async () => {
  // The assertion that separates "reads dependsOn" from "returns the first
  // undone task". Without the field being read, the answer here is T1 in both
  // states and the test passes for the wrong reason.
  const service = await fresh();
  const { id } = await flowWithTasks(service, "Reversed order", [
    { title: "implement it", dependsOn: ["T2"] },
    { title: "write the spec" },
  ]);

  const decision = await service.next({ cwd: ROOT, id });

  expect(decision.kind).toBe("ready");
  expect(decision.kind === "ready" && decision.task.id).toBe("T2");
});

test("AC6: work that remains with nothing startable is `blocked`, not `none`", async () => {
  const service = await fresh();
  const { id, dir } = await flowWithTasks(service, "Cyclic work", [
    { title: "a", dependsOn: ["T2"] },
    { title: "b", dependsOn: ["T1"] },
  ]);

  const decision = await service.next({ cwd: ROOT, id });

  expect(decision.kind).toBe("blocked");
  expect(decision.kind === "blocked" && decision.blocked.map((entry) => entry.task.id)).toEqual(["T1", "T2"]);
  // And the same state, through the CLI an operator runs, exits non-zero:
  // "nothing can start" reported as "nothing to do" would close a flow over
  // open work.
  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  await flowCommand(["next", id]);
  expect(process.exitCode).toBe(1);
  expect(logs.join("\n")).toContain("T1");
  expect(await readRaw(dir)).toBeDefined();
});

test("AC6: `keryx flow next` names the task and the dependencies it waited for", async () => {
  const service = await fresh();
  const { id } = await flowWithTasks(service, "CLI resume", [
    { title: "write the spec" },
    { title: "implement it", dependsOn: ["T1"] },
  ]);
  await service.taskDone({ cwd: ROOT, id, taskId: "T1" });

  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  await flowCommand(["next", id]);

  const printed = logs.join("\n");
  expect(printed).toContain("T2");
  expect(printed).toContain("implement it");
  expect(printed).toContain("T1");
  expect(process.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// `dependsOn` — checked by `flow check`
// ---------------------------------------------------------------------------

test("AC6: `flow check` fails on a dependency that names no task", async () => {
  const service = await fresh();
  const { id } = await flowWithTasks(service, "Typo dependency", [{ title: "only task" }]);
  await service.taskAdd({ cwd: ROOT, id, title: "second", dependsOn: ["T9"] });

  const result = await service.check({ cwd: ROOT });

  expect(result.ok).toBe(false);
  expect(result.issues.some((issue) => issue.kind === "dependency" && issue.message.includes("T9"))).toBe(true);
});

test("AC6: `flow check` fails on a self-dependency and on a cycle", () => {
  // Pure, because these two shapes cannot be produced through `taskAdd` in a
  // single call — the cycle needs its second edge to exist first — and a
  // hand-written flow.json is exactly how they reach disk.
  expect(
    dependencyIssues([
      { id: "T1", title: "a", kind: "implement", status: "todo", dependsOn: ["T1"] },
    ]).map((issue) => issue.kind),
  ).toEqual(["self-dependency"]);

  expect(
    dependencyIssues([
      { id: "T1", title: "a", kind: "implement", status: "todo", dependsOn: ["T2"] },
      { id: "T2", title: "b", kind: "implement", status: "todo", dependsOn: ["T1"] },
    ]).map((issue) => `${issue.kind}:${issue.task}`),
  ).toEqual(["cycle:T1", "cycle:T2"]);
});

test("AC6: a sound dependency graph produces no issues", () => {
  expect(
    dependencyIssues([
      { id: "T1", title: "a", kind: "implement", status: "done" },
      { id: "T2", title: "b", kind: "implement", status: "todo", dependsOn: ["T1"] },
      { id: "T3", title: "c", kind: "implement", status: "todo", dependsOn: ["T1", "T2"] },
    ]),
  ).toEqual([]);
  expect(nextTask([{ id: "T1", title: "a", kind: "implement", status: "done" }])).toEqual({ kind: "none" });
});

// ---------------------------------------------------------------------------
// `attempts.count` — written by the code that closes the task
// ---------------------------------------------------------------------------

test("AC6: closing a task `failed` records the attempt, without a second command", async () => {
  // The whole point. `keryx flow task attempt` existed and worked and nothing
  // called it, so the counter stayed at zero across seven flows. It is now
  // written on the path an operator already runs.
  const service = await fresh();
  const { id, dir } = await flowWithTasks(service, "Failed work", [{ title: "the thing" }]);

  await service.taskDone({
    cwd: ROOT,
    id,
    taskId: "T1",
    disposition: "failed",
    reason: "the migration could not be reversed",
  });

  const task = (await readRaw(dir)).tasks[0];
  expect(task?.attempts?.count).toBe(1);
  expect(task?.attempts?.log[0]?.outcome).toBe("failed");
  expect(task?.attempts?.log[0]?.detail).toBe("the migration could not be reversed");
});

test("AC6: closing a task `blocked` records it too, and `completed`/`skipped` do not", async () => {
  const service = await fresh();
  const { id, dir } = await flowWithTasks(service, "Mixed closes", [
    { title: "blocked one" },
    { title: "done one" },
    { title: "skipped one" },
  ]);

  await service.taskDone({ cwd: ROOT, id, taskId: "T1", disposition: "blocked", reason: "waiting on an API key" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T2", disposition: "completed" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T3", disposition: "skipped", reason: "not needed" });

  const tasks = (await readRaw(dir)).tasks;
  expect(tasks[0]?.attempts?.count).toBe(1);
  // A skip was never attempted; inventing an attempt for it would make the log
  // say work happened that did not.
  expect(tasks[1]?.attempts?.count).toBe(0);
  expect(tasks[2]?.attempts?.count).toBe(0);
});

test("AC6: the explicit verb and the implicit record share one counter", async () => {
  const service = await fresh();
  const { id, dir } = await flowWithTasks(service, "Two attempts", [{ title: "the thing" }]);

  await service.taskAttempt({ cwd: ROOT, id, taskId: "T1", outcome: "started" });
  await service.taskDone({ cwd: ROOT, id, taskId: "T1", disposition: "failed", reason: "still red" });

  const task = (await readRaw(dir)).tasks[0];
  expect(task?.attempts?.count).toBe(2);
  expect(task?.attempts?.log.map((entry) => entry.outcome)).toEqual(["started", "failed"]);
});

// ---------------------------------------------------------------------------
// `attempts.count` — checked by `flow check`
// ---------------------------------------------------------------------------

test("AC6: `flow check` fails on a task recorded failed with no attempt behind it", async () => {
  // Only reachable by a hand-edit now that `taskDone` records the attempt — and
  // that is precisely the record this refuses: a claim that work was tried,
  // holding nothing that was.
  const service = await fresh();
  const { id, dir } = await flowWithTasks(service, "Hand-edited failure", [{ title: "the thing" }]);
  await service.taskDone({ cwd: ROOT, id, taskId: "T1", disposition: "failed", reason: "red" });

  const raw = await readRaw(dir);
  const task = raw.tasks[0];
  if (task) {
    task.attempts = { count: 0, log: [] };
  }
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "flow.json"),
    `${JSON.stringify(raw, null, 2)}\n`,
    "utf8",
  );

  const result = await service.check({ cwd: ROOT });

  expect(result.issues.some((issue) => issue.kind === "attempts" && issue.message.includes("T1"))).toBe(true);
});

test("AC6: a failed task that carries its attempt passes the check", async () => {
  const service = await fresh();
  const { id } = await flowWithTasks(service, "Honest failure", [{ title: "the thing" }]);
  await service.taskDone({ cwd: ROOT, id, taskId: "T1", disposition: "failed", reason: "red" });

  const result = await service.check({ cwd: ROOT });

  expect(result.issues.filter((issue) => issue.kind === "attempts")).toEqual([]);
});
