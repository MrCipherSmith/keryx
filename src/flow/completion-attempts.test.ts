// Flow 291, AC4 — `flow complete` persists the outcome of every gate it
// evaluated on EVERY attempt, pass or fail, as an append-only additive field
// (`FlowState.completionAttempts`) — no longer reduced to one prose history
// line, and with no new schema version.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { createFlowService } from "./service";
import { flowStateSchema } from "./schema";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowService, FlowServiceDeps, TrackerAdapter } from "./types";

let ROOT = "";
const HEAD = "1234abcd1234abcd1234abcd1234abcd1234abcd";

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

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-22T10:00:00Z"),
    ...over,
  };
}

async function fresh(deps: Partial<FlowServiceDeps> = {}): Promise<FlowService> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-completion-attempts-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService(makeDeps(deps));
}

afterEach(async () => {
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

function flowJsonPath(dir: string): string {
  return path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
}

test("AC4: a failing attempt then a passing one both land on `completionAttempts`, in order, each with its own gate outcomes", async () => {
  const service = await fresh();
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Fail then pass", owner: "Aleks" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });

  // Attempt 1: nothing confirmed, no review package, no tasks done — a
  // real, multi-gate failure, not a thrown exception.
  const first = await service.complete({ cwd: ROOT, id: flow.id, signedBy: "Aleks" });
  expect(first.passed).toBe(false);
  expect(first.flow.completionAttempts).toHaveLength(1);
  const attempt1 = first.flow.completionAttempts?.[0];
  expect(attempt1?.passed).toBe(false);
  expect(attempt1?.gates.some((gate) => gate.name === "acceptance-criteria" && gate.status === "fail")).toBe(true);
  expect(attempt1?.gates.some((gate) => gate.name === "tasks" && gate.status === "fail")).toBe(true);
  expect(attempt1?.acChecksum).toBe(first.flow.acChecksum);
  // Prior behavior preserved: a failed attempt still folds only the FAILING
  // gates into one prose history line — this change adds a structured record
  // alongside it, it does not replace it.
  const failedEvent = first.flow.history.at(-1);
  expect(failedEvent?.event).toBe("completion-failed");

  // Fix everything, and go back through `implemented` (the state machine
  // requires it: a failed attempt returns the flow to `in-progress`, and
  // `completing` is only reachable from `implemented`).
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });

  const second = await service.complete({ cwd: ROOT, id: flow.id, signedBy: "Aleks" });
  expect(second.passed).toBe(true);
  expect(second.flow.completionAttempts).toHaveLength(2);
  // The first attempt's record is untouched — append-only.
  expect(second.flow.completionAttempts?.[0]).toEqual(attempt1);
  const attempt2 = second.flow.completionAttempts?.[1];
  expect(attempt2?.passed).toBe(true);
  expect(attempt2?.gates.every((gate) => gate.status !== "fail")).toBe(true);
  // Every evaluated gate is on the record, including the PASSING ones — not
  // only what failed.
  expect((attempt2?.gates ?? []).map((gate): string => gate.name).sort()).toEqual(
    ["acceptance-criteria", "base-branch", "health", "owner", "pull-request", "review", "tasks"].sort(),
  );
});

test("AC4: a completion attempt is recorded even on a pre-change fixture that never had `completionAttempts` or `gates`", async () => {
  const service = await fresh();
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Pre-change fixture" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });

  // Simulate a flow.json written before flow 289/291: no `gates` opt-in
  // object (so tasks/review/owner gate as `skipped`, exactly as a real
  // pre-289 package does today) and no `signatures`/`completionAttempts` at
  // all. `flow.json` is otherwise never hand-edited (D-02) — this is a test
  // fixture standing in for real repository history, not a runtime path.
  const before = JSON.parse(await readFile(flowJsonPath(dir), "utf8")) as Record<string, unknown>;
  delete before["gates"];
  delete before["signatures"];
  delete before["completionAttempts"];
  await writeFile(flowJsonPath(dir), `${JSON.stringify(before, null, 2)}\n`, "utf8");

  // Loads and validates unchanged.
  const reloaded = JSON.parse(await readFile(flowJsonPath(dir), "utf8")) as Record<string, unknown>;
  expect(validateAgainstSchemaObject(flowStateSchema(), reloaded).valid).toBe(true);

  const result = await service.complete({ cwd: ROOT, id: flow.id });

  // No `gates` opt-in means tasks/review/owner report `skipped`, never
  // `fail` — completion still passes, exactly as it would have before this
  // change existed.
  expect(result.passed).toBe(true);
  expect(result.flow.completionAttempts).toHaveLength(1);
  const attempt = result.flow.completionAttempts?.[0];
  expect(attempt?.passed).toBe(true);
  expect(attempt?.gates.find((gate) => gate.name === "tasks")?.status).toBe("skipped");
  expect(attempt?.gates.find((gate) => gate.name === "review")?.status).toBe("skipped");
  expect(attempt?.gates.find((gate) => gate.name === "owner")?.status).toBe("skipped");
  // The completed flow.json still validates against the (updated) schema —
  // additive means old data plus the new field both fit.
  expect(validateAgainstSchemaObject(flowStateSchema(), result.flow).valid).toBe(true);
  expect(result.flow.schemaVersion).toBeLessThanOrEqual(2); // no new schema version introduced
});

test("AC4 review fix: a tamper caught between gate evaluation and persistence is still recorded on disk, as a failed attempt naming the tamper", async () => {
  let dir = "";
  // The health gate stands in for "some gate that takes real time" — by the
  // time it runs, gate 1 (acceptance-criteria) has ALREADY checked the file
  // and passed. Tampering from inside it reproduces the exact race: the
  // criteria file changes WHILE later gates are still running, after the
  // one check that exists specifically to catch this has already happened.
  const service = await fresh({
    healthGate: async () => {
      await writeAc(dir, ["Only criterion (tampered mid-complete!)"]);
      return { status: "pass", reasons: [] };
    },
  });
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Tamper mid complete", owner: "Aleks" });
  dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }

  // The final transition's own AC re-check still throws on a genuine
  // out-of-band edit — that contract is unchanged. What must not happen is
  // losing the attempt's record because of it.
  await expect(service.complete({ cwd: ROOT, id: flow.id, signedBy: "Aleks" })).rejects.toThrow(
    /do not match their recorded checksum/,
  );

  const onDisk = JSON.parse(await readFile(flowJsonPath(dir), "utf8")) as {
    completionAttempts?: Array<{ passed: boolean; gates: Array<{ name: string; status: string; detail: string }> }>;
    signatures?: Array<{ kind: string }>;
  };
  expect(onDisk.completionAttempts).toHaveLength(1);
  const attempt = onDisk.completionAttempts?.[0];
  expect(attempt?.passed).toBe(false);
  // Every gate this attempt evaluated is still on the record, including the
  // ones that passed before the tamper was caught (the health gate itself
  // still reports `pass` — it did its job before tampering on the way out).
  expect(attempt?.gates.some((gate) => gate.name === "health" && gate.status === "pass")).toBe(true);
  // A tamper-naming failure is appended, alongside gate 1's earlier (now
  // stale) pass — both are on the record, not one replacing the other.
  const tamperGates = attempt?.gates.filter((gate) => gate.name === "acceptance-criteria") ?? [];
  expect(tamperGates.some((gate) => gate.status === "fail" && /checksum/.test(gate.detail))).toBe(true);
  // No COMPLETION signature was recorded (the earlier `ac-confirm` one from
  // setup is expected and untouched) — a tamper caught here must not let a
  // false "all gates passed" claim get signed.
  expect((onDisk.signatures ?? []).some((signature) => signature.kind === "complete")).toBe(false);
});
