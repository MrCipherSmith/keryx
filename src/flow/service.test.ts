import { afterAll, mock, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowServiceDeps, TrackerAdapter } from "./types";

// Real `./review-gate` and `./store` exports, snapshotted eagerly so a
// mock's restore hands back the genuine implementation rather than leaking
// the break into later tests (same discipline as
// src/security/guard.test.ts's breakConfigLoad/restoreConfigLoad).
// `reviewGate` has exactly one call site in service.ts (Gate 4's try), so
// mocking it for the span of one test cannot disturb any other method under
// test here. `./store` is used far more broadly, so its mock below overrides
// only `readAcCriteria` and is applied only after every setup step (freeze,
// start, taskDone, implemented, acConfirm) has already run for real.
const realReviewGateExports = { ...(await import("./review-gate")) };
const realStoreExports = { ...(await import("./store")) };

// Each test gets its own OS temp dir (no shared path -> no cross-test/CI flakes).
let ROOT = "";

// The PR head the fake tracker reports; a review round has to have run against
// it for the review gate (flow 204) to pass.
const HEAD = "d00d1d00d2d00d3d00d4d00d5d00d6d00d7d00d8";

function fakeTracker(over: Partial<{
  checksGreen: boolean;
  exists: boolean;
  isDraft: boolean;
  commented: string[];
}> = {}): TrackerAdapter & { commented: string[] } {
  const commented: string[] = over.commented ?? [];
  return {
    id: "fake",
    commented,
    detect: async () => true,
    parseRef: (input) => {
      const match = input.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
      return match?.[1] && match[2] ? { repo: match[1], number: Number(match[2]) } : null;
    },
    fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
    prStatus: async () => ({
      exists: over.exists ?? true,
      isDraft: over.isDraft ?? true,
      checksGreen: over.checksGreen ?? true,
      headSha: HEAD,
    }),
    comment: async (_ref, body) => {
      commented.push(body);
      return true;
    },
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-07T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-flow-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

afterAll(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
});

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  const file = path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md");
  await writeFile(
    file,
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

test("init scaffolds the package; ids increment; freeze rejects placeholder AC", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));

  const first = await service.init({ cwd: ROOT, title: "Fix login timeout" });
  expect(first.flow.id).toBe("001");
  expect(first.flow.status).toBe("initializing");
  expect(first.dir).toContain("001-2026-07-07-fix-login-timeout");
  for (const file of ["flow.json", "description.md", "context.md", "plan.md", "tasks.md", "acceptance-criteria.md", "journal.md"]) {
    const content = await readFile(path.join(ROOT, first.dir, file), "utf8");
    expect(content.length).toBeGreaterThan(0);
  }

  const second = await service.init({ cwd: ROOT, title: "Another story" });
  expect(second.flow.id).toBe("002");

  // Placeholder AC must not freeze.
  await expect(service.freeze({ cwd: ROOT, id: "001" })).rejects.toThrow(/at least one real/);
});

test("concurrent init calls allocate unique flow ids", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));

  const results = await Promise.all([
    service.init({ cwd: ROOT, title: "Concurrent alpha" }),
    service.init({ cwd: ROOT, title: "Concurrent beta" }),
  ]);

  expect(results.map((result) => result.flow.id).sort()).toEqual(["001", "002"]);
  expect(new Set(results.map((result) => result.dir)).size).toBe(2);
});

test("freeze locks AC; tampering blocks transitions and is caught by check", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));
  const { flow } = await service.init({ cwd: ROOT, title: "Guard the criteria" });
  const dir = `001-2026-07-07-guard-the-criteria`;

  await writeAc(dir, ["Login succeeds within 2s"]);
  const frozen = await service.freeze({ cwd: ROOT, id: flow.id });
  expect(frozen.status).toBe("ready");
  expect(frozen.acChecksum).toMatch(/^sha256:/);

  // Tamper outside the CLI.
  await writeAc(dir, ["Login succeeds within 20s (loosened!)"]);
  // The refusal states the OBSERVATION (checksum does not match) and names both
  // routes out, because a mismatch has two causes and only one of them is an
  // edit. It used to assert the cause — "modified outside the task-manager" —
  // which is false for a stale seal over an unchanged file.
  await expect(service.start({ cwd: ROOT, id: flow.id })).rejects.toThrow(
    /do not match their recorded checksum/,
  );
  await expect(service.start({ cwd: ROOT, id: flow.id })).rejects.toThrow(/ac update/);
  await expect(service.start({ cwd: ROOT, id: flow.id })).rejects.toThrow(/ac reseal/);

  const check = await service.check({ cwd: ROOT });
  expect(check.ok).toBe(false);
  expect(check.issues.some((issue) => issue.kind === "checksum")).toBe(true);

  // ac update is the sanctioned path.
  await service.acUpdate({ cwd: ROOT, id: flow.id, reason: "requirement loosened by owner" });
  const started = await service.start({ cwd: ROOT, id: flow.id });
  expect(started.status).toBe("in-progress");
});

test("full happy path: start -> tasks -> implemented -> confirm -> complete(done) + issue comment", async () => {
  await fresh();
  const tracker = fakeTracker();
  const service = createFlowService(makeDeps({ tracker }));

  const { flow } = await service.init({
    cwd: ROOT,
    issue: "https://github.com/acme/app/issues/42",
  });
  expect(flow.title).toBe("Issue title");
  expect(flow.source.type).toBe("github-issue");
  const dir = `001-2026-07-07-issue-title`;

  await writeAc(dir, ["Criterion one", "Criterion two"]);
  await service.freeze({ cwd: ROOT, id: "001" });
  await service.start({ cwd: ROOT, id: "001" });

  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: "001", taskId });
  }

  // implemented requires a PR; status authority enforced by machine.
  await expect(service.complete({ cwd: ROOT, id: "001" })).rejects.toThrow(/Invalid flow transition/);
  await service.implemented({ cwd: ROOT, id: "001", prUrl: "https://github.com/acme/app/pull/43" });

  await service.acConfirm({ cwd: ROOT, id: "001", criterion: "AC1", note: "verified manually" });
  await service.acConfirm({ cwd: ROOT, id: "001", criterion: "AC2" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/43" });

  const result = await service.complete({ cwd: ROOT, id: "001", comment: true });
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
  expect(result.gates.map((gate) => gate.name)).toEqual([
    "acceptance-criteria",
    "pull-request",
    "base-branch",
    "tasks",
    "review",
    "health",
  ]);
  // `skipped`: no base recorded on this fixture. See the merged-completion
  // test above for why that is neither a pass nor a failure.
  expect(result.gates.map((gate) => gate.status)).toEqual([
    "pass",
    "pass",
    "skipped",
    "pass",
    "pass",
    "pass",
  ]);
  expect(result.commented).toBe(true);
  expect(tracker.commented[0]).toContain("Flow 001");
  expect(tracker.commented[0]).toContain("pull/43");
});

test("failed gates return the flow to in-progress with fix notes", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      tracker: fakeTracker({ checksGreen: false }),
      healthGate: async () => ({ status: "fail", reasons: ["P0 findings"] }),
    }),
  );

  const { flow } = await service.init({ cwd: ROOT, title: "Gate failure path" });
  const dir = `001-2026-07-07-gate-failure-path`;
  await writeAc(dir, ["Must be verified"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  // AC1 deliberately NOT confirmed.

  const result = await service.complete({ cwd: ROOT, id: flow.id });
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
  const failedNames = result.gates.filter((gate) => gate.status === "fail").map((gate) => gate.name);
  // The scaffolded T1-T4 are still `todo`, so the task gate fails alongside
  // the other three — and no review round was ever recorded, so the review gate
  // fails too rather than passing on the absence of one.
  expect(failedNames).toEqual(["acceptance-criteria", "pull-request", "tasks", "review", "health"]);
  expect(result.flow.history.some((event) => event.event === "completion-failed")).toBe(true);
});

test("merged completion closes a flow without a PR when main contains the commit", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      tracker: null,
      mainMergeGate: async (_cwd, commit) =>
        commit === "7b78ff14"
          ? { status: "pass", detail: "7b78ff14 is contained in origin/main" }
          : { status: "fail", detail: `${commit} is not contained in origin/main` },
    }),
  );

  const { flow } = await service.init({ cwd: ROOT, title: "Merged handoff" });
  const dir = "001-2026-07-07-merged-handoff";
  await writeAc(dir, ["Implementation is present on main"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  // No PR on this path, so the review gate compares the round against the
  // merged commit instead, and the external-comment condition is satisfied by
  // there being no PR anybody could have commented on.
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: "7b78ff14", prUrl: null });

  const result = await service.complete({ cwd: ROOT, id: flow.id, mergedCommit: "7b78ff14" });

  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
  expect(result.flow.merged?.commit).toBe("7b78ff14");
  expect(result.flow.merged?.ref).toBe("origin/main");
  expect(result.gates.map((gate) => gate.name)).toEqual([
    "acceptance-criteria",
    "main-merge",
    "base-branch",
    "tasks",
    "review",
    "health",
  ]);
  // `base-branch` is `skipped`, not `pass`: this fixture's flow records no base
  // branch, and "nothing to compare against" must not read as "compared and
  // matched". The three states are three — see `baseBranchCondition`.
  expect(result.gates.map((gate) => gate.status)).toEqual([
    "pass",
    "pass",
    "skipped",
    "pass",
    "pass",
    "pass",
  ]);
});

// T35 F-005 / T45 regression: a healthGate that THROWS is a check that could
// not run, not one that was deliberately skipped. Before the fix the catch
// arm recorded `status: "skipped"`, which the pass/fail fold
// (`gates.every((gate) => gate.status !== "fail")`) treats as non-blocking --
// so an unexpected error in the health gate let the flow complete anyway.
// The detail must not echo the thrown text either: it can carry a path or
// file content.
test("healthGate that throws blocks completion, not skips it, and never echoes the thrown text", async () => {
  await fresh();
  const secretPath = "/Users/attacker/.ssh/id_rsa";
  const service = createFlowService(
    makeDeps({
      healthGate: async () => {
        throw new Error(`ENOENT: no such file or directory, open '${secretPath}'`);
      },
    }),
  );

  const { flow } = await service.init({ cwd: ROOT, title: "Health gate throws" });
  const dir = `001-2026-07-07-health-gate-throws`;
  await writeAc(dir, ["Must be verified"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/9" });

  const result = await service.complete({ cwd: ROOT, id: flow.id });
  const health = result.gates.find((gate) => gate.name === "health");
  expect(health?.status).toBe("fail");
  expect(health?.detail).not.toContain(secretPath);
  expect(health?.detail).not.toContain("ENOENT");
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
});

// T39 F-001 / T56 regression: the pre-fix fold was `status === "fail" ? fail
// : pass`, so `incomplete` -- the value the health module produces exactly
// when a REQUIRED source is unavailable, failed to execute, or failed to
// parse (src/health/gate.ts:58-63) -- fell through to the permissive arm and
// was recorded `pass`, letting completion succeed on evidence policies.md
// calls INCOMPLETE, not PASS. This is the AC8 sentence itself: "no required
// failed or incomplete check is relabeled PASS at any surface, including the
// recorded completion row."
test("healthGate -> incomplete blocks completion, not relabeled pass", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      healthGate: async () => ({
        status: "incomplete",
        reasons: ["INCOMPLETE: required source unavailable: typescript"],
      }),
    }),
  );

  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Health gate incomplete" });
  const dir = path.basename(created);
  await writeAc(dir, ["Must be verified"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/9" });

  const result = await service.complete({ cwd: ROOT, id: flow.id });
  const health = result.gates.find((gate) => gate.name === "health");
  expect(health?.status).toBe("fail");
  expect(health?.status).not.toBe("pass");
  expect(health?.detail).toContain("required source unavailable");
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
});

// T39 F-001 / T56 regression: the same fallthrough also passed any value the
// fold had not been taught -- a future GateStatus member, or a non-conforming
// healthGate dependency. The fix's default arm must block like every sibling
// fold's default arm (gateExitCode, runExitCode, isPassGate,
// securityFlowGate's switch), and must not echo the unrecognized value into
// the detail that reaches flow.json history and buildIssueComment.
test("healthGate -> unrecognized status blocks completion, not relabeled pass, and does not echo the value", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      healthGate: async () => ({ status: "banana", reasons: ["should never surface verbatim"] }),
    }),
  );

  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Health gate unrecognized" });
  const dir = path.basename(created);
  await writeAc(dir, ["Must be verified"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/9" });

  const result = await service.complete({ cwd: ROOT, id: flow.id });
  const health = result.gates.find((gate) => gate.name === "health");
  expect(health?.status).toBe("fail");
  expect(health?.status).not.toBe("pass");
  expect(health?.detail).not.toContain("banana");
  expect(health?.detail).not.toContain("should never surface verbatim");
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
});

// T56: pins the deliberate `warn` decision (see T56-spec.md) so a future edit
// to this fold changes it visibly rather than by accident. Both health CLI
// surfaces (`keryx health run`, `keryx health gate`) exit 0 for `warn` unless
// an explicit strict opt-in is passed, and `flow complete()` has no strict
// equivalent to opt into -- so `warn` stays non-blocking here too. The row
// still differs from a genuine pass in its detail, even though `status` is
// the same "pass" both times.
//
// T57 F-001 / T60 regression: the in-memory checks below (`result.gates`)
// were already true and already passing before T60's fix -- they are exactly
// the assertions an independent review found insufficient, because the
// detail they pin never reached the two durable/published surfaces a reader
// actually sees. Added here: read `flow.json` back off disk (not the return
// value) and check `result.issueComment` (the string that would actually be
// posted), so this test would have failed while the defect stood.
test("healthGate -> warn still completes, but the row is not identical to a genuine pass", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      healthGate: async () => ({ status: "warn", reasons: ["WARN: coverage 40% below soft floor 60%"] }),
    }),
  );

  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Health gate warn" });
  const dir = path.basename(created);
  await writeAc(dir, ["Must be verified"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/9" });

  const result = await service.complete({ cwd: ROOT, id: flow.id });
  const health = result.gates.find((gate) => gate.name === "health");
  expect(health?.status).toBe("pass");
  expect(health?.detail).toBe("health gate: warn");
  expect(health?.detail).not.toBe("health gate: pass");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");

  // The persisted artifact, not the return value.
  const stored = JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8"),
  ) as { history: { event: string; detail?: string }[] };
  const doneEvent = stored.history.at(-1);
  expect(doneEvent?.event).toBe("done");
  expect(doneEvent?.detail).toContain("warn");
  expect(doneEvent?.detail).not.toBe("all gates passed");

  // The comment that would actually be posted, not a status field.
  expect(result.issueComment).toContain("warn");
});

// T57 F-001 / T60 regression: a committed version of the reviewer's own
// probe (T57-flow.ts, row C99). Drives complete() twice end to end, against
// two independent fixtures -- one health pass, one health warn -- and
// compares the PERSISTED flow.json and the PUBLISHED issue comment byte for
// byte, exactly as a machine or a human reading the tracker would. Before
// T60's fix these were byte-identical in both slots; this pins that they are
// not, and that a genuine pass's record/comment are unaffected by the fix
// (no new field, no new text for the common case).
test("a warn completion's stored flow.json and issue comment are NOT identical to a genuine pass's", async () => {
  async function driveToComplete(status: "pass" | "warn"): Promise<{ stored: string; comment: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "gd-flow-warncompare-"));
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    try {
      const service = createFlowService(
        makeDeps({
          healthGate: async () => ({ status, reasons: status === "warn" ? ["WARN: coverage low"] : [] }),
        }),
      );
      // Same title/slug/id for both runs (each root starts fresh, so both
      // allocate "001") -- the ONLY difference driving the two fixtures must
      // be the health gate's status, or a difference in the stored record
      // would prove nothing about this fix specifically.
      const { flow, dir: created } = await service.init({ cwd: root, title: "Health gate check" });
      const dir = path.basename(created);
      await writeFile(
        path.join(root, ".metaproject", "flows", dir, "acceptance-criteria.md"),
        "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Must be verified\n",
        "utf8",
      );
      await service.freeze({ cwd: root, id: flow.id });
      await service.start({ cwd: root, id: flow.id });
      for (const taskId of ["T1", "T2", "T3", "T4"]) {
        await service.taskDone({ cwd: root, id: flow.id, taskId });
      }
      await service.implemented({ cwd: root, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
      await service.acConfirm({ cwd: root, id: flow.id, criterion: "AC1" });
      await writeCleanReviewPackage({
        cwd: root,
        flowDir: dir,
        head: HEAD,
        prUrl: "https://github.com/acme/app/pull/9",
      });
      const result = await service.complete({ cwd: root, id: flow.id });
      const stored = await readFile(path.join(root, ".metaproject", "flows", dir, "flow.json"), "utf8");
      return { stored, comment: result.issueComment ?? "" };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const genuinePass = await driveToComplete("pass");
  const warn = await driveToComplete("warn");

  // Not identical -- the actual defect (T57 F-001) was that these matched.
  expect(warn.stored).not.toBe(genuinePass.stored);
  expect(warn.comment).not.toBe(genuinePass.comment);

  // The word is actually present in both durable surfaces for the warn run.
  expect(warn.stored.toLowerCase()).toContain("warn");
  expect(warn.comment.toLowerCase()).toContain("warn");

  // A genuine pass carries no trace of "warn" and is byte-identical to the
  // pre-fix constant in its "done" history entry -- the fix changes nothing
  // for the common case.
  expect(genuinePass.stored.toLowerCase()).not.toContain("warn");
  expect(genuinePass.comment.toLowerCase()).not.toContain("warn");
  const genuineHistory = (
    JSON.parse(genuinePass.stored) as { history: { at: string; event: string; detail?: string }[] }
  ).history;
  expect(genuineHistory.at(-1)).toEqual({
    at: "2026-07-07T10:00:00.000Z",
    event: "done",
    detail: "all gates passed",
  });
});

// T45 flagged and deliberately left open, T47 closes it: gates 1
// (acceptance-criteria) and 4 (review) already recorded `status: "fail"` on a
// throw -- the blocking half was correct -- but their `detail` interpolated
// the caught error's message verbatim, which can carry a filesystem path or
// file content (policies.md, "Redaction и security scan").
//
// `readAcCriteria`/`assertAcIntact` are direct `./store` imports used by
// several other service methods (freeze, start's `transition()`, acConfirm,
// and `complete()`'s own top-of-function `assertAcIntact` check before the
// gates loop even starts) -- deleting the on-disk file would trip that
// earlier, unguarded call first, never reaching Gate 1's own catch. So this
// mocks only `readAcCriteria` (leaving the real `assertAcIntact` in place,
// which is why every setup step and `complete()`'s own preflight check keep
// passing) and restores it in `finally`, the same snapshot/break/restore
// discipline `src/security/guard.test.ts` uses for `loadSecurityConfig`.
test("acceptance-criteria gate that throws blocks completion, not skips it, and never echoes the thrown text", async () => {
  await fresh();
  const secretPath = "/Users/attacker/.ssh/id_rsa";
  const service = createFlowService(makeDeps());
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "AC gate throws" });
  const dir = path.basename(created);
  await writeAc(dir, ["Must be verified"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/9" });

  mock.module("./store", () => ({
    ...realStoreExports,
    readAcCriteria: async () => {
      throw new Error(`ENOENT: no such file or directory, open '${secretPath}'`);
    },
  }));
  try {
    const result = await service.complete({ cwd: ROOT, id: flow.id });
    const ac = result.gates.find((gate) => gate.name === "acceptance-criteria");
    expect(ac?.status).toBe("fail");
    expect(ac?.detail).not.toContain(secretPath);
    expect(ac?.detail).not.toContain("ENOENT");
    expect(result.passed).toBe(false);
    expect(result.flow.status).toBe("in-progress");
  } finally {
    mock.module("./store", () => ({ ...realStoreExports }));
  }
});

test("review gate that throws blocks completion, not skips it, and never echoes the thrown text", async () => {
  await fresh();
  const secretPath = "/Users/attacker/.ssh/id_rsa";
  mock.module("./review-gate", () => ({
    ...realReviewGateExports,
    reviewGate: async () => {
      throw new Error(`ENOENT: no such file or directory, open '${secretPath}'`);
    },
  }));
  try {
    const service = createFlowService(makeDeps());
    const { flow } = await service.init({ cwd: ROOT, title: "Review gate throws" });
    const dir = `001-2026-07-07-review-gate-throws`;
    await writeAc(dir, ["Must be verified"]);
    await service.freeze({ cwd: ROOT, id: flow.id });
    await service.start({ cwd: ROOT, id: flow.id });
    for (const taskId of ["T1", "T2", "T3", "T4"]) {
      await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
    }
    await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
    await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });

    const result = await service.complete({ cwd: ROOT, id: flow.id });
    const review = result.gates.find((gate) => gate.name === "review");
    expect(review?.status).toBe("fail");
    expect(review?.detail).not.toContain(secretPath);
    expect(review?.detail).not.toContain("ENOENT");
    expect(result.passed).toBe(false);
    expect(result.flow.status).toBe("in-progress");
  } finally {
    mock.module("./review-gate", () => ({ ...realReviewGateExports }));
  }
});

test("block stores the previous status and unblock restores it", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));
  const { flow } = await service.init({ cwd: ROOT, title: "Blockable" });
  const dir = `001-2026-07-07-blockable`;
  await writeAc(dir, ["ok"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });

  const blocked = await service.block({ cwd: ROOT, id: flow.id, reason: "waiting on API keys" });
  expect(blocked.status).toBe("blocked");
  const resumed = await service.unblock({ cwd: ROOT, id: flow.id });
  expect(resumed.status).toBe("in-progress");
});
