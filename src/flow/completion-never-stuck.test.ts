// Flow 299, AC5 and AC6: `flow complete` never leaves a flow in `completing`,
// and `flow recover` moves one that an interrupted process did leave there.
//
// AC5 covers the three ways a completion used to end stuck:
// - a changed criteria file caught during the gates, on both a passing and a
//   failing attempt;
// - a changed criteria file landing after a passing attempt was recorded;
// - a throw from the merge, pull-request or base-branch gate.
// Each case must record a failed attempt naming the cause, return the flow to
// `in-progress` on disk, and write no `complete` signature.
//
// AC6 covers `flow recover`: its refusals, what it records, and what it never
// touches.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withFileLock } from "../lib/fs";
import { flowCommand } from "../commands/flow";
import { createFlowService } from "./service";
import { writeCleanReviewPackage } from "./review-fixtures";
import { flowLockPathFor, interruptedCompletionLine, isCompletionInterrupted } from "./store";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";
const HEAD = "1234abcd1234abcd1234abcd1234abcd1234abcd";
const PR = "https://github.com/acme/app/pull/1";
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

function fakeTracker(over: Partial<TrackerAdapter> = {}): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
    ...over,
  };
}

async function fresh(deps: Partial<FlowServiceDeps> = {}): Promise<FlowService> {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-never-stuck-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService({
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-23T10:00:00Z"),
    ...deps,
  });
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

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

async function onDisk(dir: string): Promise<FlowState> {
  return JSON.parse(await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8")) as FlowState;
}

/** A flow every gate would pass: frozen, confirmed, tasks done, a clean review round. */
async function readyFlow(
  service: FlowService,
  dirRef: { dir: string },
  opts: { implemented?: boolean } = {},
): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Never stuck", owner: "Aleks" });
  const dir = path.basename(created);
  dirRef.dir = dir;
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  if (opts.implemented !== false) {
    await service.implemented({ cwd: ROOT, id: flow.id, prUrl: PR });
  }
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  return { id: flow.id, dir };
}

function expectNotStuck(flow: FlowState): void {
  expect(flow.status).toBe("in-progress");
  expect((flow.signatures ?? []).some((signature) => signature.kind === "complete")).toBe(false);
}

test("AC5: criteria changed during the gates on an otherwise PASSING attempt — failed attempt recorded, flow back in in-progress", async () => {
  const ref = { dir: "" };
  const service = await fresh({
    healthGate: async () => {
      await writeAc(ref.dir, ["Only criterion (edited mid-complete)"]);
      return { status: "pass", reasons: [] };
    },
  });
  const { id, dir } = await readyFlow(service, ref);

  const result = await service.complete({ cwd: ROOT, id });
  expect(result.passed).toBe(false);

  const flow = await onDisk(dir);
  expectNotStuck(flow);
  expect(flow.completionAttempts).toHaveLength(1);
  const attempt = flow.completionAttempts?.[0];
  expect(attempt?.passed).toBe(false);
  expect(
    attempt?.gates.some((gate) => gate.name === "acceptance-criteria" && gate.status === "fail" && /changed after/.test(gate.detail)),
  ).toBe(true);
  expect(flow.history.at(-1)?.event).toBe("completion-failed");
});

test("AC5: criteria changed during the gates on a FAILING attempt — failed attempt recorded, flow back in in-progress", async () => {
  const ref = { dir: "" };
  const service = await fresh({
    healthGate: async () => {
      await writeAc(ref.dir, ["Only criterion (edited mid-complete)"]);
      return { status: "fail", reasons: ["P0 findings"] };
    },
  });
  const { id, dir } = await readyFlow(service, ref);

  const result = await service.complete({ cwd: ROOT, id });
  expect(result.passed).toBe(false);
  const flow = await onDisk(dir);
  expectNotStuck(flow);
  const gates = flow.completionAttempts?.[0]?.gates ?? [];
  expect(gates.some((gate) => gate.name === "health" && gate.status === "fail")).toBe(true);
  expect(gates.some((gate) => gate.name === "acceptance-criteria" && /changed after/.test(gate.detail))).toBe(true);
});

test("AC5: criteria changed AFTER a passing attempt was recorded — a second, failed attempt names it; the first is untouched", async () => {
  const ref = { dir: "" };
  let tampered = false;
  const service = await fresh({
    afterAttemptRecorded: async () => {
      if (tampered) return;
      tampered = true;
      await writeAc(ref.dir, ["Only criterion (edited between record and done)"]);
    },
  });
  const { id, dir } = await readyFlow(service, ref);

  const result = await service.complete({ cwd: ROOT, id });
  expect(result.passed).toBe(false);
  const flow = await onDisk(dir);
  expectNotStuck(flow);
  expect(flow.completionAttempts).toHaveLength(2);
  expect(flow.completionAttempts?.[0]?.passed).toBe(true);
  const late = flow.completionAttempts?.[1];
  expect(late?.passed).toBe(false);
  expect(late?.gates[0]?.detail).toMatch(/after attempt 1 was recorded as passing, before the flow could be marked done/);
});

test("AC5: the pull-request and base-branch gates throwing — recorded as unevaluable, flow back in in-progress", async () => {
  const ref = { dir: "" };
  const service = await fresh({
    tracker: fakeTracker({
      prStatus: async () => {
        throw new Error("gh: HTTP 502 while reading /home/secret/path");
      },
    }),
  });
  // `implemented` itself reads the PR through the tracker, so the flow is made
  // ready with a working tracker and completed with the failing one.
  const ready = await fresh();
  const { id, dir } = await readyFlow(ready, ref);

  const result = await service.complete({ cwd: ROOT, id });
  expect(result.passed).toBe(false);
  const flow = await onDisk(dir);
  expectNotStuck(flow);
  const gates = flow.completionAttempts?.[0]?.gates ?? [];
  expect(gates.find((gate) => gate.name === "pull-request")?.detail).toBe(
    "pull-request gate could not be evaluated; treated as failed, not skipped",
  );
  expect(gates.find((gate) => gate.name === "base-branch")?.status).toBe("fail");
  // The caught error's text never reaches the record.
  expect(JSON.stringify(flow)).not.toContain("/home/secret/path");
});

test("AC5: the merge gate throwing on a --merged completion — recorded as unevaluable, flow back in in-progress", async () => {
  const ref = { dir: "" };
  const service = await fresh({
    mainMergeGate: async () => {
      throw new Error("git exploded");
    },
  });
  const { id, dir } = await readyFlow(service, ref, { implemented: false });

  const result = await service.complete({ cwd: ROOT, id, mergedCommit: "7b78ff14" });
  expect(result.passed).toBe(false);
  const flow = await onDisk(dir);
  expectNotStuck(flow);
  expect(flow.completionAttempts?.[0]?.gates.find((gate) => gate.name === "main-merge")?.status).toBe("fail");
});

test("AC5: criteria integrity is still enforced on the next forward transition after a tamper", async () => {
  const ref = { dir: "" };
  const service = await fresh({
    healthGate: async () => {
      await writeAc(ref.dir, ["Only criterion (edited mid-complete)"]);
      return { status: "pass", reasons: [] };
    },
  });
  const { id } = await readyFlow(service, ref);
  await service.complete({ cwd: ROOT, id });

  await expect(service.implemented({ cwd: ROOT, id, prUrl: PR })).rejects.toThrow(/do not match their recorded checksum/);
  await service.acUpdate({ cwd: ROOT, id, reason: "the edit was intended" });
  const again = await service.implemented({ cwd: ROOT, id, prUrl: PR });
  expect(again.status).toBe("implemented");
});

/** A flow left in `completing` by a process that died right after recording its attempt. */
async function stuckFlow(): Promise<{ service: FlowService; id: string; dir: string; before: FlowState }> {
  const ref = { dir: "" };
  const dying = await fresh({
    afterAttemptRecorded: async () => {
      throw new Error("process killed");
    },
  });
  const { id, dir } = await readyFlow(dying, ref);
  await expect(dying.complete({ cwd: ROOT, id })).rejects.toThrow("process killed");
  const before = await onDisk(dir);
  expect(before.status).toBe("completing");
  const service = createFlowService({
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-23T11:00:00Z"),
  });
  return { service, id, dir, before };
}

test("AC6: flow recover returns a stuck flow to in-progress, records why, and leaves signatures and attempts alone", async () => {
  const { service, id, dir, before } = await stuckFlow();
  expect(await isCompletionInterrupted(ROOT, before)).toBe(true);

  const recovered = await service.recover({ cwd: ROOT, id, reason: "the terminal closed mid-complete" });
  expect(recovered.status).toBe("in-progress");

  const after = await onDisk(dir);
  expect(after.status).toBe("in-progress");
  expect(after.signatures).toEqual(before.signatures);
  expect(after.completionAttempts).toEqual(before.completionAttempts);
  const event = after.history.at(-1);
  expect(event?.event).toBe("completion-recovered");
  expect(event?.detail).toContain("the terminal closed mid-complete");
  expect(event?.detail).toContain("last event before the interruption: completion-attempt-recorded at");
  expect(event?.detail).toContain("acceptance criteria: intact");
  const journal = await readFile(path.join(ROOT, ".metaproject", "flows", dir, "journal.md"), "utf8");
  expect(journal).toContain("completion-recovered: the terminal closed mid-complete");
});

test("AC6: flow recover reports a changed criteria file instead of requiring it away", async () => {
  const { service, id, dir } = await stuckFlow();
  await writeAc(dir, ["Only criterion (edited while stuck)"]);
  const recovered = await service.recover({ cwd: ROOT, id, reason: "stuck after an edit" });
  expect(recovered.history.at(-1)?.detail).toContain("acceptance criteria: changed since frozen");
});

test("AC6: flow recover refuses without a reason, from any other status, and while the flow lock is held", async () => {
  const { service, id, dir } = await stuckFlow();
  await expect(service.recover({ cwd: ROOT, id, reason: "  " })).rejects.toThrow(/requires --reason/);

  await expect(
    withFileLock(flowLockPathFor(ROOT, dir), async () => {
      expect(await isCompletionInterrupted(ROOT, { id, status: "completing" })).toBe(false);
      return service.recover({ cwd: ROOT, id, reason: "racing a live complete" });
    }),
  ).rejects.toThrow(/another process holds flow .* lock/);
  expect((await onDisk(dir)).status).toBe("completing");

  await service.recover({ cwd: ROOT, id, reason: "now it is really stuck" });
  await expect(service.recover({ cwd: ROOT, id, reason: "again" })).rejects.toThrow(/is "in-progress", not "completing"/);
});

test("AC6: the CLI — `flow status` labels the interrupted flow and names the command; `flow recover` moves it", async () => {
  const { id, dir } = await stuckFlow();
  process.chdir(ROOT);
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));

  await flowCommand(["status", id]);
  expect(logs.join("\n")).toContain(interruptedCompletionLine(id));

  await flowCommand(["recover", id]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("Usage: keryx flow recover");
  process.exitCode = 0;

  logs.length = 0;
  await flowCommand(["recover", id, "--reason", "closed the laptop"]);
  expect(process.exitCode).toBe(0);
  expect((await onDisk(dir)).status).toBe("in-progress");

  logs.length = 0;
  await flowCommand(["status", id]);
  expect(logs.join("\n")).not.toContain("interrupted:");
});
