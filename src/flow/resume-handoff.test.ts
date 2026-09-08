// Flow 237 — handoff and resume: can a different agent, or the same agent after
// a restart, tell what already happened?
//
// The defect this file exists to hold closed is not a missing feature, it is a
// collapse of three answers into two. `keryx flow next` printed
//
//     → T1 Collect remaining context (context)
//       no declared dependencies; this is the first task that is not done
//
// for a task nobody had ever touched AND for a task an agent had started and
// died inside — byte for byte the same two lines, measured on this repository
// before the change. `flow status` printed a bare `1 attempt(s)`, which is
// equally true of an attempt that failed and closed and of one that opened and
// never came back. So the record could say "this already happened" and "this
// never started", and had no way at all to say "I cannot tell" — the resumed
// agent either redid landed work or skipped work that never happened, silently
// in both directions.
//
// Why the interruption here is real rather than simulated: a test that hand-wrote
// `{outcome: "started"}` into flow.json would pass identically in a build where
// no process can ever be interrupted at that point, which is the exact shape of
// the defect one layer up. So the worker below is a REAL child process, running
// the REAL FlowService, which records its attempt, writes a REAL partial artifact
// into the tree, and is then SIGKILLed — no handler, no unwind, no chance to
// record an end. Every assertion afterwards runs in a FRESH process that shares
// nothing with it but the directory, and reads the CLI's own stdout rather than
// an in-process return value.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { taskResumeState } from "./machine";
import type { FlowTask } from "./types";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const ROOTS: string[] = [];

afterEach(async () => {
  while (ROOTS.length > 0) {
    const root = ROOTS.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

type Run = { code: number | null; stdout: string; stderr: string };

/**
 * Every test below drives the REAL CLI as a child process — several spawns of
 * `keryx` per test through `startedFlow`/`keryx`, plus `interruptAWorker`'s own
 * up-to-20s wait for a real worker process to open its attempt before it can be
 * SIGKILLed. None of that is bounded by anything smaller than this budget, so
 * bun's 5s default was already too tight even before counting load: measured on
 * this repository, a run of this file alone takes low seconds, but under full
 * parallel `bun test` — dozens of files each spawning their own child
 * processes — process scheduling alone can push a single test past 5s with no
 * change to the code under test. That surfaced as `keryx` children killed
 * mid-spawn (SIGTERM, exit 143) when bun tore down a "timed out" test, which is
 * a false failure about scheduler contention, not about resume/handoff
 * behavior. Sized well above the 20s worst case inside `interruptAWorker` plus
 * room for the surrounding `keryx()` calls, matching the convention used for
 * other CLI-spawning tests in this repository (e.g. `src/commands/ctx.test.ts`).
 *
 * `60_000` (this constant's previous value) turned out to be the same failure
 * one order of magnitude up, not a fix of it: reproduced by running 4 copies of
 * this file concurrently alongside unrelated stress load (20+ copies of
 * `src/ctx/hook-native-search.test.ts` plus a full `bun test` in the
 * background). Every copy failed on the FIRST test, "a SIGKILLed worker leaves
 * an attempt no later process can mistake for 'never started'", at
 * `[60005-60021ms] this test timed out after 60000ms` — 5-21ms over a
 * 60-SECOND budget — and bun's teardown then killed the NEXT test's
 * freshly-spawned `keryx flow init` mid-flight (`Received: 143`), the exact
 * "torn down mid-spawn" collateral failure the paragraph above already names,
 * just no longer prevented once the ceiling itself is this close. "`flow
 * status` separates an open attempt from a closed one, not just by count" does
 * MORE real `keryx()` round-trips than that first test (`interruptAWorker` up
 * to 20s, then THREE sequential real CLI calls rather than one or two), so it
 * is the test most exposed to the same near-zero margin under load. Tripled
 * here for the same reason `src/ctx/artifact-race.e2e.test.ts`'s own
 * real-process budget was doubled after an equivalent measured near-miss: the
 * margin was effectively zero, not comfortable.
 */
const REAL_PROCESS_TEST_TIMEOUT_MS = 180_000;

/** One fresh `keryx` process in `cwd`. Shares no state with any other run. */
async function keryx(cwd: string, args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

/** A started flow package on disk, built through the real CLI. */
async function startedFlow(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-resume-"));
  ROOTS.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  const init = await keryx(root, ["flow", "init", "--title", "Resume and handoff"]);
  expect(init.code).toBe(0);
  await writeFile(
    path.join(root, ".metaproject", "flows", "001-2026-09-08-resume-and-handoff", "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n- AC1: Only criterion\n",
    "utf8",
  ).catch(async () => {
    // The dated slug is generated from the clock; find it rather than assume it.
    const dir = await firstFlowDir(root);
    await writeFile(
      path.join(dir, "acceptance-criteria.md"),
      "# Acceptance Criteria\n\n- AC1: Only criterion\n",
      "utf8",
    );
  });
  expect((await keryx(root, ["flow", "freeze", "001"])).code).toBe(0);
  expect((await keryx(root, ["flow", "start", "001"])).code).toBe(0);
  return root;
}

async function firstFlowDir(root: string): Promise<string> {
  const flows = path.join(root, ".metaproject", "flows");
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(flows)).filter((entry) => !entry.startsWith("."));
  const first = entries[0];
  if (!first) {
    throw new Error("no flow package was created");
  }
  return path.join(flows, first);
}

/**
 * The worker: opens an attempt through the real service, leaves a real partial
 * artifact behind, signals readiness, and then never returns. The caller kills
 * it. Nothing here writes an end, and after SIGKILL nothing can.
 */
function workerSource(root: string, marker: string, artifact: string): string {
  return `
import { createFlowService } from ${JSON.stringify(path.join(import.meta.dir, "service.ts"))};
import { writeFile } from "node:fs/promises";
import { githubAdapter } from ${JSON.stringify(path.join(import.meta.dir, "tracker", "github.ts"))};

const service = createFlowService({
  tracker: githubAdapter,
  healthGate: async () => ({ status: "pass", reasons: [] }),
  now: () => new Date(),
});
await service.taskAttempt({ cwd: ${JSON.stringify(root)}, id: "001", taskId: "T1", outcome: "started", detail: "worker opened the attempt" });
// Real, half-finished work in the tree. Its presence is what makes "did this
// land?" a genuine question rather than a rhetorical one.
await writeFile(${JSON.stringify(artifact)}, "half of the work the killed worker was doing\\n", "utf8");
await writeFile(${JSON.stringify(marker)}, "ready\\n", "utf8");
// Past this point the process is doing the task. It will not get to close it.
await new Promise(() => {});
`;
}

/** Spawn the worker, wait until it has really opened the attempt, SIGKILL it. */
async function interruptAWorker(root: string): Promise<{ signal: string | null; artifact: string }> {
  const marker = path.join(root, "worker-ready");
  const artifact = path.join(root, "partial-work.txt");
  const script = path.join(root, "worker.mjs");
  await writeFile(script, workerSource(root, marker, artifact), "utf8");

  const child = Bun.spawn([process.execPath, script], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 20000;
  while (!(await pathExists(marker))) {
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`worker never opened its attempt: ${await new Response(child.stderr).text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // SIGKILL: uncatchable, so no exit handler, no flush, no closing record.
  child.kill("SIGKILL");
  await child.exited;
  return { signal: child.signalCode, artifact };
}

test("a SIGKILLed worker leaves an attempt no later process can mistake for 'never started'", async () => {
  const interrupted = await startedFlow();
  const { signal, artifact } = await interruptAWorker(interrupted);
  // The interruption is real, not arranged: the worker died to an uncatchable
  // signal, and its half-done work is sitting in the tree.
  expect(signal).toBe("SIGKILL");
  expect(await pathExists(artifact)).toBe(true);

  // A control flow, identical in every respect except that nobody touched it.
  const untouched = await startedFlow();

  const afterCrash = await keryx(interrupted, ["flow", "next", "001"]);
  const fresh = await keryx(untouched, ["flow", "next", "001"]);

  // THE assertion. Before this change these two strings were equal.
  expect(afterCrash.stdout).not.toBe(fresh.stdout);

  expect(afterCrash.stdout).toContain("never recorded an end");
  expect(afterCrash.stdout).toContain("UNKNOWN");
  // And it must not claim to know the worker died — an open attempt is equally
  // consistent with another agent still holding it, since the flow lock covers
  // one mutation and not one task.
  expect(afterCrash.stdout).not.toContain("crashed");
  expect(afterCrash.stdout).not.toContain("no recorded attempt");

  expect(fresh.stdout).toContain("no recorded attempt");
  expect(fresh.stdout).not.toContain("UNKNOWN");
}, REAL_PROCESS_TEST_TIMEOUT_MS);

test("the resume state reaches a programmatic consumer, not only the human line", async () => {
  const root = await startedFlow();
  await interruptAWorker(root);

  const decision = JSON.parse((await keryx(root, ["flow", "next", "001", "--json"])).stdout) as {
    kind: string;
    resume: { kind: string; reason?: string };
    unresolved: Array<{ task: { id: string } }>;
  };
  expect(decision.kind).toBe("ready");
  expect(decision.resume.kind).toBe("unresolved");
  expect(decision.resume.reason).toBe("attempt-not-closed");
  expect(decision.unresolved.map((entry) => entry.task.id)).toEqual(["T1"]);
}, REAL_PROCESS_TEST_TIMEOUT_MS);

test("`flow status` separates an open attempt from a closed one, not just by count", async () => {
  const root = await startedFlow();
  await interruptAWorker(root);

  const open = await keryx(root, ["flow", "status", "001"]);
  expect(open.stdout).toContain("1 attempt(s)");
  expect(open.stdout).toContain("outcome UNKNOWN");

  // Closing the attempt is the act that resolves it. The count goes UP — so a
  // reader keying on the count alone would see the situation get worse.
  expect((await keryx(root, ["flow", "task", "attempt", "001", "T1", "--outcome", "failed", "--detail", "checked the tree; redoing"])).code).toBe(0);

  const closed = await keryx(root, ["flow", "status", "001"]);
  expect(closed.stdout).toContain("2 attempt(s)");
  expect(closed.stdout).not.toContain("UNKNOWN");
}, REAL_PROCESS_TEST_TIMEOUT_MS);

test("an open attempt behind the next task is reported, not hidden behind it", async () => {
  const root = await startedFlow();
  await interruptAWorker(root);
  // T1 is resolved and closed; T3 is opened and abandoned. `flow next` will hand
  // back T2, and T3's open attempt must not wait behind it.
  await keryx(root, ["flow", "task", "attempt", "001", "T1", "--outcome", "failed"]);
  await keryx(root, ["flow", "task", "done", "001", "T1"]);
  await keryx(root, ["flow", "task", "attempt", "001", "T3", "--outcome", "started"]);

  const next = await keryx(root, ["flow", "next", "001"]);
  expect(next.stdout).toContain("T2");
  expect(next.stdout).toContain("T3 has an attempt opened");
  expect(next.stdout).toContain("other task(s) carry an attempt with no recorded end");
}, REAL_PROCESS_TEST_TIMEOUT_MS);

test("a completed task is 'already happened', even though its log ends open", async () => {
  const root = await startedFlow();
  await interruptAWorker(root);
  expect((await keryx(root, ["flow", "task", "done", "001", "T1"])).code).toBe(0);

  const next = await keryx(root, ["flow", "next", "001"]);
  expect(next.stdout).toContain("T2");
  expect(next.stdout).not.toContain("T1 has an attempt opened");
  expect(next.stdout).not.toContain("UNKNOWN");

  // Why this case is not hypothetical: `taskDone --disposition completed`
  // deliberately appends no closing entry, so for EVERY completed task the log
  // ends `started`. Across the 200 flow packages in this repository, 1739 tasks,
  // 99 have a log ending `started` — and all 99 are `done`. A classifier that
  // read the log before the status would have accused all 99 of being interrupted.
  const dir = await firstFlowDir(root);
  const flow = JSON.parse(await readFile(path.join(dir, "flow.json"), "utf8")) as { tasks: FlowTask[] };
  const t1 = flow.tasks.find((task) => task.id === "T1");
  expect(t1?.status).toBe("done");
  expect(t1?.attempts?.log.at(-1)?.outcome).toBe("started");
  expect(taskResumeState(t1 as FlowTask).kind).toBe("done");
}, REAL_PROCESS_TEST_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// The shapes a crash cannot produce, but a hand-edit or a truncated file can.
// `writeFlow` is atomic, so these cannot be reached by killing a process; they
// are reached by someone editing flow.json. They are here because the wrong
// answer for them is the dangerous one: a counter claiming attempts with no log
// to date them is an ABSENCE of evidence, and must not read as "never started".
// ---------------------------------------------------------------------------

test("a task list that cannot account for its own attempts reads as unknown, never as untouched", () => {
  const countWithoutLog: FlowTask = {
    id: "T1", title: "a", kind: "implement", status: "todo",
    attempts: { count: 2, log: [] },
  };
  expect(taskResumeState(countWithoutLog)).toEqual({
    kind: "unresolved",
    reason: "count-without-log",
    attempts: 2,
  });

  const logIncomplete: FlowTask = {
    id: "T2", title: "b", kind: "implement", status: "todo",
    attempts: { count: 5, log: [{ at: "2026-09-08T00:00:00.000Z", outcome: "failed" }] },
  };
  expect(taskResumeState(logIncomplete).kind).toBe("unresolved");

  // The control: genuinely untouched, and genuinely closed.
  expect(taskResumeState({ id: "T3", title: "c", kind: "implement", status: "todo" })).toEqual({
    kind: "never-started",
  });
  expect(
    taskResumeState({
      id: "T4", title: "d", kind: "implement", status: "todo",
      attempts: { count: 1, log: [{ at: "2026-09-08T00:00:00.000Z", outcome: "blocked" }] },
    }),
  ).toEqual({ kind: "ended", outcome: "blocked", at: "2026-09-08T00:00:00.000Z", attempts: 1 });
});
