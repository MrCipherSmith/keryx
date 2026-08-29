// Flow 201 — the attempt counter (AC8, AC9).
//
// `attempts: {count, log}` has existed in the FlowTask type since TM-01 and was
// written exactly once, as `{count: 0, log: []}`, by `taskAdd`. Nothing ever
// incremented it: it is non-zero in 3 of 196 packages, and only because the
// v1 -> v2 migration back-fills a single inferred attempt.
//
// The bug the counter exists to fix is a session restart resetting an
// orchestrator's in-memory retry budget to zero. A test that only observes the
// counter inside the process that wrote it would therefore pass while the bug
// is fully present, so every assertion here re-reads the package from disk.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
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

let clock = 0;
function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    // Distinct timestamps so the append-only log is ordered and comparable.
    now: () => new Date(Date.UTC(2026, 7, 29, 10, 0, clock++)),
    ...over,
  };
}

/**
 * A brand-new service instance over the same directory. This is the "session
 * restart": it shares no closure, no cache and no in-memory state with the
 * service that recorded the attempts — only the files on disk.
 */
function restartedSession(): FlowService {
  return createFlowService(makeDeps());
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  clock = 0;
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-attempts-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function startedFlow(service: FlowService): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Attempt counter" });
  const dir = path.basename(created);
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Only criterion\n",
    "utf8",
  );
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  return { id: flow.id, dir };
}

async function readRawFlow(dir: string): Promise<FlowState> {
  return JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8"),
  ) as FlowState;
}

test("AC8 — `task attempt` increments attempts.count and appends to attempts.log", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await startedFlow(service);

  const first = await service.taskAttempt({ cwd: ROOT, id, taskId: "T2", outcome: "started" });
  expect(first.tasks.find((task) => task.id === "T2")?.attempts?.count).toBe(1);

  const second = await service.taskAttempt({
    cwd: ROOT,
    id,
    taskId: "T2",
    outcome: "failed",
    detail: "verifier reported 3 type errors",
  });
  const t2 = second.tasks.find((task) => task.id === "T2");
  expect(t2?.attempts?.count).toBe(2);
  expect(t2?.attempts?.log.map((entry) => entry.outcome)).toEqual(["started", "failed"]);
  expect(t2?.attempts?.log[1]?.detail).toBe("verifier reported 3 type errors");
});

test("AC9 — the count survives a session restart: a fresh service reads the persisted value, not zero", async () => {
  await fresh();
  const writing = createFlowService(makeDeps());
  const { id, dir } = await startedFlow(writing);

  await writing.taskAttempt({ cwd: ROOT, id, taskId: "T2", outcome: "started" });
  await writing.taskAttempt({ cwd: ROOT, id, taskId: "T2", outcome: "failed", detail: "round 1" });
  await writing.taskAttempt({ cwd: ROOT, id, taskId: "T2", outcome: "blocked", detail: "round 2" });

  // Session restart: nothing is carried over but the directory path.
  const resumed = restartedSession();
  const reloaded = await resumed.get({ cwd: ROOT, id });
  const t2 = reloaded.tasks.find((task) => task.id === "T2");

  expect(t2?.attempts?.count).toBe(3);
  expect(t2?.attempts?.log.map((entry) => entry.outcome)).toEqual(["started", "failed", "blocked"]);

  // And it is genuinely on disk, not reconstructed by the read-time migration
  // (which would have inferred count 0 for a `todo` task).
  const raw = await readRawFlow(dir);
  expect(raw.tasks.find((task) => task.id === "T2")?.attempts?.count).toBe(3);

  // A restarted session continues the counter rather than restarting it.
  const continued = await resumed.taskAttempt({ cwd: ROOT, id, taskId: "T2", outcome: "started" });
  expect(continued.tasks.find((task) => task.id === "T2")?.attempts?.count).toBe(4);
  expect((await readRawFlow(dir)).tasks.find((task) => task.id === "T2")?.attempts?.count).toBe(4);
});

test("AC9 — prior log entries are never rewritten across a restart (append-only)", async () => {
  await fresh();
  const writing = createFlowService(makeDeps());
  const { id, dir } = await startedFlow(writing);

  await writing.taskAttempt({ cwd: ROOT, id, taskId: "T3", outcome: "started", detail: "first" });
  const afterFirst = (await readRawFlow(dir)).tasks.find((task) => task.id === "T3")?.attempts?.log[0];

  await restartedSession().taskAttempt({ cwd: ROOT, id, taskId: "T3", outcome: "failed" });

  const log = (await readRawFlow(dir)).tasks.find((task) => task.id === "T3")?.attempts?.log;
  expect(log).toHaveLength(2);
  expect(log?.[0]).toEqual(afterFirst as never);
});

test("attempts are per-task; recording one does not touch its siblings", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await startedFlow(service);

  await service.taskAttempt({ cwd: ROOT, id, taskId: "T1", outcome: "started" });
  await service.taskAttempt({ cwd: ROOT, id, taskId: "T1", outcome: "failed" });

  const raw = await readRawFlow(dir);
  expect(raw.tasks.find((task) => task.id === "T1")?.attempts?.count).toBe(2);
  for (const taskId of ["T2", "T3", "T4"]) {
    expect(raw.tasks.find((task) => task.id === taskId)?.attempts?.count ?? 0).toBe(0);
  }
});

test("a lowercase task id resolves, and an unknown one names the known ids", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await startedFlow(service);

  const flow = await service.taskAttempt({ cwd: ROOT, id, taskId: "t4", outcome: "started" });
  expect(flow.tasks.find((task) => task.id === "T4")?.attempts?.count).toBe(1);

  await expect(
    service.taskAttempt({ cwd: ROOT, id, taskId: "T99", outcome: "started" }),
  ).rejects.toThrow(/Task not found: T99\. Known: T1, T2, T3, T4/);
});

test("the attempt is recorded in flow history and journal, so a resume can read it back", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await startedFlow(service);

  await service.taskAttempt({
    cwd: ROOT,
    id,
    taskId: "T2",
    outcome: "blocked",
    detail: "worker returned BLOCKED: missing API credentials",
  });

  const raw = await readRawFlow(dir);
  const event = raw.history.find((entry) => entry.event === "task-attempt");
  expect(event?.detail).toContain("T2: blocked (attempt 1)");
  expect(event?.detail).toContain("missing API credentials");

  const journal = await readFile(path.join(ROOT, ".metaproject", "flows", dir, "journal.md"), "utf8");
  expect(journal).toContain("task-attempt: T2: blocked (attempt 1)");
});
