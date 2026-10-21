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
    ["acceptance-criteria", "base-branch", "confirmation", "folder-committed", "health", "owner", "pull-request", "review", "tasks"].sort(),
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

  // Flow 299 (AC5) changed the ending: this used to throw from the final
  // transition's own AC re-check and leave the flow in `completing`. It now
  // returns a failed result and puts the flow back in `in-progress`. What
  // flow 291 pinned is unchanged: the attempt's record is not lost.
  const result = await service.complete({ cwd: ROOT, id: flow.id, signedBy: "Aleks" });
  expect(result.passed).toBe(false);

  const onDisk = JSON.parse(await readFile(flowJsonPath(dir), "utf8")) as {
    status?: string;
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
  expect(onDisk.status).toBe("in-progress");
});

for (const confirmed of [true, false]) {
  test(`exception completion requires an operator decision: ${confirmed}`, async () => {
    const service = await fresh({ healthGate: async () => ({ status: "fail", reasons: ["released regression"] }) });
    const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Released with exception", owner: "Aleks" });
    const dir = path.basename(created);
    await writeAc(dir, ["Only criterion"]);
    await service.freeze({ cwd: ROOT, id: flow.id });
    await service.start({ cwd: ROOT, id: flow.id });
    await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
    await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
    await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/1" });
    for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
    let asked = false;
    const result = await service.complete({
      cwd: ROOT, id: flow.id, acceptGates: ["health"], reason: "released; tracked separately",
      confirmExceptions: async (selected) => {
        asked = true;
        expect(selected[0]?.detail).toContain("released regression");
        return confirmed ? { operatorWords: "Да", confirmedVia: "host-question", hostQuestion: {
          source: "codex", ref: "fresh-host-answer", time: "2026-09-22T10:00:00.000Z",
          questionText: "Complete flow with the shown exceptions?", answerText: "Да",
        } } : undefined;
      },
    });
    expect(asked).toBe(true);
    expect(result.passed).toBe(confirmed);
    expect(result.flow.status).toBe(confirmed ? "done" : "in-progress");
    const attempt = result.flow.completionAttempts?.at(-1);
    expect(attempt?.gates.find((gate) => gate.name === "health")?.status).toBe("fail");
    if (confirmed) {
      expect(attempt?.cleanCompletion).toBe(false);
      expect(attempt?.exceptions).toEqual([expect.objectContaining({ gate: "health", reason: "released; tracked separately", operatorWords: "Да", confirmedVia: "host-question", at: "2026-09-22T10:00:00.000Z" })]);
      expect(result.flow.signatures?.at(-1)?.cleanCompletion).toBe(false);
      expect(validateAgainstSchemaObject(flowStateSchema(), result.flow).valid).toBe(true);
      const journal = await readFile(path.join(ROOT, ".metaproject", "flows", dir, "journal.md"), "utf8");
      expect(journal).toContain("completed with exceptions");
      expect(journal).toContain("released; tracked separately");
      expect(journal).not.toContain("done: all gates passed");
      await expect(service.complete({ cwd: ROOT, id: flow.id })).rejects.toThrow();
    } else {
      expect(attempt?.exceptions).toBeUndefined();
      expect(result.flow.signatures?.some((signature) => signature.kind === "complete")).toBe(false);
    }
  });
}


test("retargeted stacked PR records a reasoned base correction", async () => {
  const service = await fresh();
  const { flow } = await service.init({ cwd: ROOT, title: "Stacked", baseBranch: "fix/round2" });
  const changed = await service.baseSet({ cwd: ROOT, id: flow.id, base: "main", reason: "PR retargeted and merged" });
  expect(changed.baseBranch).toBe("main");
  expect(changed.history.at(-1)?.detail).toContain("fix/round2");
  expect(changed.history.at(-1)?.detail).toContain("PR retargeted and merged");
  await expect(service.baseSet({ cwd: ROOT, id: flow.id, base: "main", reason: " " })).rejects.toThrow();
});

test("a fix PR appends lineage and becomes the current review head target", async () => {
  const service = await fresh();
  const { flow, dir } = await service.init({ cwd: ROOT, title: "Follow-up" });
  await writeAc(path.basename(dir), ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/23" });
  const fixed = await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/24", fixOf: "round1" });
  expect(fixed.pr.url).toBe("https://github.com/acme/app/pull/24");
  expect(fixed.pr.previous).toEqual([{ url: "https://github.com/acme/app/pull/23", fixOf: "round1" }]);
  expect(validateAgainstSchemaObject(flowStateSchema(), fixed).valid).toBe(true);
  const persisted = JSON.parse(await readFile(flowJsonPath(path.basename(dir)), "utf8"));
  expect(persisted.pr).toEqual(fixed.pr);
  expect(validateAgainstSchemaObject(flowStateSchema(), persisted).valid).toBe(true);
  expect((await service.check({ cwd: ROOT })).issues).toEqual([]);
});


test("base correction alone recovers completion without replacing PR or review rounds", async () => {
  const service = await fresh({ tracker: fakeTracker({ prStatus: async () => ({ exists: true, isDraft: false, checksGreen: true, headSha: HEAD, baseRefName: "main" }) }) });
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Retargeted only", owner: "Aleks", baseBranch: "fix/round2" });
  const dir = path.basename(created);
  await writeAc(dir, ["Released"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/25" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  const round = await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/25" });
  const reviewBefore = await readFile(path.join(round, "manifest.json"), "utf8");
  const before = await service.get({ cwd: ROOT, id: flow.id });
  const failed = await service.checkComplete({ cwd: ROOT, id: flow.id });
  expect(failed.gates.filter(g => g.status === "fail").map(g => g.name)).toEqual(["base-branch"]);
  await service.baseSet({ cwd: ROOT, id: flow.id, base: "main", reason: "PR25 retargeted to main" });
  const after = await service.get({ cwd: ROOT, id: flow.id });
  expect(after.pr).toEqual(before.pr);
  expect(after.acConfirmed).toEqual(before.acConfirmed);
  expect(after.tasks).toEqual(before.tasks);
  expect(await readFile(path.join(round, "manifest.json"), "utf8")).toBe(reviewBefore);
  expect(await service.checkComplete({ cwd: ROOT, id: flow.id })).toMatchObject({ passed: true });
  const completed = await service.complete({ cwd: ROOT, id: flow.id });
  expect(completed.passed).toBe(true);
  expect(completed.flow.signatures?.at(-1)?.cleanCompletion).toBe(true);
  expect(await readFile(path.join(round, "manifest.json"), "utf8")).toBe(reviewBefore);
});

test("flow exception confirmation cannot reuse a consumed host reference", async () => {
  const service = await fresh({ healthGate: async () => ({ status: "fail", reasons: ["released regression"] }) });
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Reopened flow", owner: "Aleks" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  const hostQuestion = { source: "codex" as const, ref: "consumed", questionText: "Complete?", answerText: "yes", time: "2026-09-22T10:00:00.000Z" };
  const file = path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.completionAttempts = [{ at: hostQuestion.time, gates: [], passed: true, acChecksum: state.acChecksum, cleanCompletion: false,
    exceptions: [{ gate: "health", detail: "released regression", reason: "shipped", operatorWords: "yes", confirmedVia: "host-question", at: hostQuestion.time, hostQuestion }] }];
  await writeFile(file, JSON.stringify(state));
  const result = await service.complete({ cwd: ROOT, id: flow.id, acceptGates: ["health"], reason: "shipped",
    confirmExceptions: async () => ({ operatorWords: "yes", confirmedVia: "host-question", hostQuestion }) });
  expect(result.passed).toBe(false);
  expect(result.gates.find((gate) => gate.name === "confirmation" && gate.status === "fail")?.detail).toContain("already used");
  expect(result.flow.status).toBe("in-progress");
});


test("exception approval refuses a moved head even when gate outcomes are identical", async () => {
  let moved = false;
  const service = await fresh({ healthGate: async () => ({ status: "fail", reasons: ["released regression"] }),
    tracker: fakeTracker({ prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: moved ? "b".repeat(40) : HEAD }) }),
  });
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Head race", owner: "Aleks" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  const result = await service.complete({ cwd: ROOT, id: flow.id, acceptGates: ["health"], reason: "shipped",
    confirmExceptions: async () => { moved = true; return { operatorWords: "yes", confirmedVia: "terminal" }; },
  });
  expect(result.passed).toBe(false);
  expect(result.gates.some(g => g.name === "confirmation" && g.status === "fail")).toBe(true);
});

// Flow 469: the four released overlay cases use the real completion service.
for (const scenario of ["merged-before-review", "retargeted-stack", "direct-main", "review-declined"] as const) {
  test(`released scenario with explicit review exceptions: ${scenario}`, async () => {
    const service = await fresh({
      tracker: fakeTracker({ prStatus: async (url) => ({ exists: true, isDraft: false, checksGreen: true,
        state: "MERGED", baseRefName: "main", headSha: url.endsWith("/24") ? "b".repeat(40) : HEAD }) }),
      mainMergeGate: async () => ({ status: "pass", detail: "implementation is contained in origin/main" }),
    });
    const { flow, dir: created } = await service.init({ cwd: ROOT, title: scenario, owner: "Aleks",
      ...(scenario === "retargeted-stack" ? { baseBranch: "fix/round2-findings" } : {}) });
    const dir = path.basename(created);
    await writeAc(dir, ["Released implementation"]);
    await service.freeze({ cwd: ROOT, id: flow.id });
    await service.start({ cwd: ROOT, id: flow.id });
    if (scenario !== "direct-main") await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/23" });
    await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
    for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
    if (scenario === "merged-before-review" || scenario === "retargeted-stack") {
      await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/23" });
      if (scenario === "retargeted-stack") {
        const before = await service.get({ cwd: ROOT, id: flow.id });
        const corrected = await service.baseSet({ cwd: ROOT, id: flow.id, base: "main", reason: "PR25 retargeted and merged" });
        expect(corrected.status).toBe("implemented");
        expect(corrected.pr).toEqual(before.pr);
        expect(corrected.acConfirmed).toEqual(before.acConfirmed);
        expect(corrected.tasks).toEqual(before.tasks);
      }
      await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/24", fixOf: "round1" });
    }
    const mergedCommit = scenario === "direct-main" ? HEAD : undefined;
    const checked = await service.checkComplete({ cwd: ROOT, id: flow.id, mergedCommit });
    const review = checked.gates.find(g => g.name === "review");
    expect(review?.status).toBe("fail");
    const conditions = review?.conditions?.filter(c => c.status !== "pass") ?? [];
    expect(conditions.length).toBeGreaterThan(0);
    expect(conditions.some(c => c.id === (scenario === "merged-before-review" || scenario === "retargeted-stack" ? "head-commit" : "ingested-round"))).toBe(true);
    const acceptGates = checked.gates.flatMap(g => g.status !== "fail" ? [] : g.name === "review"
      ? conditions.map(c => `review:${c.id}`) : [g.name]);
    let asked = false;
    const omitted = await service.complete({ cwd: ROOT, id: flow.id, mergedCommit,
      acceptGates: acceptGates.slice(1), reason: "Known released exception",
      confirmExceptions: async () => { asked = true; return { operatorWords: "yes", confirmedVia: "terminal" }; } });
    expect(omitted.passed).toBe(false);
    expect(asked).toBe(false);
    if (!mergedCommit) {
      const current = await service.get({ cwd: ROOT, id: flow.id });
      await service.implemented({ cwd: ROOT, id: flow.id, prUrl: current.pr.url! });
    }
    const completed = await service.complete({ cwd: ROOT, id: flow.id, mergedCommit,
      acceptGates, reason: "Released by operator; subsequent PRs contain fixes",
      confirmExceptions: async selected => {
        expect(selected.every(s => s.detail.length > 0)).toBe(true);
        return { operatorWords: "Да", confirmedVia: "terminal" };
      } });
    expect(completed.passed).toBe(true);
    expect(completed.flow.status).toBe("done");
    expect(completed.flow.signatures?.at(-1)?.cleanCompletion).toBe(false);
    expect(completed.flow.completionAttempts?.at(-1)?.gates.find(g => g.name === "review")?.status).toBe("fail");
    const persisted = await service.get({ cwd: ROOT, id: flow.id });
    expect(persisted.completionAttempts?.at(-1)?.exceptions).toContainEqual(expect.objectContaining({
      reason: "Released by operator; subsequent PRs contain fixes", operatorWords: "Да", confirmedVia: "terminal",
    }));
    expect(validateAgainstSchemaObject(flowStateSchema(), persisted).valid).toBe(true);
  });
}

for (const changed of ["head", "detail"] as const) {
  test(`exception confirmation binds independent ${changed} changes`, async () => {
    let moved = false;
    const service = await fresh({
      tracker: fakeTracker({ prStatus: async () => ({ exists: true, checksGreen: true, isDraft: false,
        headSha: moved && changed === "head" ? "b".repeat(40) : HEAD }) }),
      healthGate: async () => ({ status: "fail", reasons: [moved && changed === "detail" ? "new refusal" : "old refusal"] }),
    });
    const { flow, dir: created } = await service.init({ cwd: ROOT, title: changed, owner: "Aleks" });
    const dir = path.basename(created);
    await writeAc(dir, ["Done"]);
    await service.freeze({ cwd: ROOT, id: flow.id });
    await service.start({ cwd: ROOT, id: flow.id });
    await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
    await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
    for (const taskId of ["T1", "T2", "T3", "T4"]) await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
    // Missing review gives identical review conditions at both heads.
    const checked = await service.checkComplete({ cwd: ROOT, id: flow.id });
    const conditions = checked.gates.find(g => g.name === "review")?.conditions ?? [];
    const result = await service.complete({ cwd: ROOT, id: flow.id, reason: "released",
      acceptGates: ["health", ...conditions.filter(c => c.status !== "pass").map(c => `review:${c.id}`)],
      confirmExceptions: async () => { moved = true; return { operatorWords: "yes", confirmedVia: "terminal" }; } });
    expect(result.passed).toBe(false);
    expect(result.gates.some(g => g.name === "confirmation" && g.status === "fail")).toBe(true);
    expect(result.flow.signatures?.some(s => s.kind === "complete")).toBe(false);
  });
}
