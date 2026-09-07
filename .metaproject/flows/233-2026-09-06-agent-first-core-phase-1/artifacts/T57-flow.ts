// T57 probe C (row 3) — the flow-completion health fold, driven through the real
// `complete()` pipeline, and then read back OUT OF THE STORED FLOW RECORD on
// disk, which is the durable evidence a machine reads. The in-memory `gates`
// array the earlier probe inspected is not that record.
//
// Read-only against production code; every fixture is `mkdtemp` and removed.
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../../../../src/flow/service";
import { writeCleanReviewPackage } from "../../../../src/flow/review-fixtures";
import type { FlowServiceDeps, TrackerAdapter } from "../../../../src/flow/types";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const HEAD = "c0ffee1c0ffee2c0ffee3c0ffee4c0ffee5c0ffe";

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
  };
}

async function driveToComplete(root: string, deps: Partial<FlowServiceDeps>) {
  const full: FlowServiceDeps = {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-07T10:00:00Z"),
    ...deps,
  } as FlowServiceDeps;
  const service = createFlowService(full);
  const { flow, dir: created } = await service.init({ cwd: root, title: "T57 gate probe" });
  await writeFile(
    path.join(root, ".metaproject", "flows", path.basename(created), "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Criterion one\n",
    "utf8",
  );
  await service.freeze({ cwd: root, id: flow.id });
  await service.start({ cwd: root, id: flow.id });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: root, id: flow.id, taskId });
  }
  await service.implemented({ cwd: root, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: root, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({
    cwd: root,
    flowDir: path.basename(created),
    head: HEAD,
    prUrl: "https://github.com/acme/app/pull/1",
  });
  const result = await service.complete({ cwd: root, id: flow.id });
  const stored = JSON.parse(
    await readFile(
      path.join(root, ".metaproject", "flows", path.basename(created), "flow.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return { result, stored };
}

type Health = { status: unknown; reasons: unknown };

const CASES: [string, Health][] = [
  ["C01 healthGate pass", { status: "pass", reasons: [] }],
  ["C02 healthGate warn", { status: "warn", reasons: ["coverage below soft floor"] }],
  ["C03 healthGate incomplete", { status: "incomplete", reasons: ["REQUIRED lint unavailable"] }],
  ["C04 healthGate fail", { status: "fail", reasons: ["threshold violation"] }],
  ["C05 healthGate banana (unrecognized)", { status: "banana", reasons: ["planted reason text"] }],
  ["C06 healthGate '' (empty string)", { status: "", reasons: ["planted reason text"] }],
  ["C07 healthGate 'PASS' (upper case)", { status: "PASS", reasons: ["planted reason text"] }],
  ["C08 healthGate 'Pass' (mixed case)", { status: "Pass", reasons: ["planted reason text"] }],
  ["C09 healthGate 'pass ' (trailing space)", { status: "pass ", reasons: ["planted reason text"] }],
  ["C10 healthGate 'skipped'", { status: "skipped", reasons: ["planted reason text"] }],
  ["C11 healthGate status null", { status: null, reasons: [] }],
  ["C12 healthGate status undefined", { status: undefined, reasons: [] }],
  ["C13 healthGate status true", { status: true, reasons: [] }],
  ["C14 healthGate status ['pass']", { status: ["pass"], reasons: [] }],
  ["C15 healthGate status object", { status: { status: "pass" }, reasons: [] }],
  ["C16 healthGate incomplete with NO reasons", { status: "incomplete", reasons: [] }],
  ["C17 healthGate warn with reasons not an array", { status: "warn", reasons: "oops" }],
  ["C18 healthGate incomplete with reasons not an array", { status: "incomplete", reasons: "oops" }],
];

for (const [label, health] of CASES) {
  const root = await mkdtemp(path.join(tmpdir(), "t57-flow-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    const { result, stored } = await driveToComplete(root, {
      healthGate: (async () => health) as unknown as FlowServiceDeps["healthGate"],
    });
    const row = result.gates.find((g) => g.name === "health");
    const history = (stored.history as { event: string; detail?: string }[]) ?? [];
    const storedJson = JSON.stringify(stored);
    out({
      label,
      returnedGateStatus: row?.status ?? null,
      returnedDetail: row?.detail ?? null,
      completionPassed: result.passed,
      storedFlowStatus: stored.status,
      // What a reader of the DURABLE record actually sees.
      storedHistoryTail: history.slice(-1).map((h) => `${h.event}: ${h.detail ?? ""}`),
      storedRecordMentionsHealth: /health/i.test(storedJson),
      storedRecordMentionsGateStatusWord: /"health gate: /.test(storedJson),
      issueCommentHealthLine:
        result.issueComment
          ?.split("\n")
          .find((l) => l.includes("health")) ?? null,
      leakedPlantedReason: /planted reason text/.test(
        `${storedJson}${result.issueComment ?? ""}${row?.detail ?? ""}`,
      ),
    });
  } catch (e) {
    out({ label, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---- The distinguishability question, put directly: is a `warn` completion
// distinguishable from a genuine `pass` completion to a reader of the stored
// flow record? Compare the two stored records byte for byte.
{
  const roots: string[] = [];
  const records: Record<string, string> = {};
  const comments: Record<string, string> = {};
  for (const status of ["pass", "warn"]) {
    const root = await mkdtemp(path.join(tmpdir(), "t57-flowdiff-"));
    roots.push(root);
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const { result, stored } = await driveToComplete(root, {
      healthGate: async () => ({ status, reasons: [] }),
    });
    records[status] = JSON.stringify(stored);
    comments[status] = result.issueComment ?? "";
  }
  try {
    out({
      label: "C99 stored flow record: genuine pass vs warn",
      storedRecordsIdentical: records.pass === records.warn,
      issueCommentsIdentical: comments.pass === comments.warn,
      issueCommentHealthLinePass: comments.pass.split("\n").find((l) => l.includes("health")) ?? null,
      issueCommentHealthLineWarn: comments.warn.split("\n").find((l) => l.includes("health")) ?? null,
      storedRecordContainsWarnWord: /warn/i.test(records.warn ?? ""),
    });
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
}
