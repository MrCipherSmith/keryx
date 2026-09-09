// T39 probe B — attack the four exit-code / gate folds and hunt a fifth site.
// Read-only against production code; every fixture is mkdtemp and removed.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exitCodeFor, reportExitCode } from "../../../../src/commands/security";
import { runReport, runGate } from "../../../../src/security/service";
import { runExitCode } from "../../../../src/commands/health";
import { gateExitCode, createCodeHealthService } from "../../../../src/health/service";
import { createFlowService } from "../../../../src/flow/service";
import { writeCleanReviewPackage } from "../../../../src/flow/review-fixtures";
import type { FlowServiceDeps, TrackerAdapter } from "../../../../src/flow/types";
import type { SecurityDecision, SecurityGate } from "../../../../src/security/types";
import type { GateStatus } from "../../../../src/health/types";

const out = (row: Record<string, unknown>) => console.log(JSON.stringify(row));

const GATES = ["pass", "fail", "needs-approval", "incomplete", "banana"];
const MODES = ["advisory", "enforced", "ci", "gateway", "BANANAS", "CI", "ci "];

function decision(gate: string): SecurityDecision {
  return { gate: gate as SecurityGate, action: "warn", findings: [] };
}

// ---------- 1. the two security CLI folds ----------
for (const mode of MODES) {
  const scanRow: Record<string, unknown> = { label: `S1 exitCodeFor mode=${JSON.stringify(mode)}` };
  const reportRow: Record<string, unknown> = { label: `S2 reportExitCode mode=${JSON.stringify(mode)}` };
  for (const gate of GATES) {
    scanRow[gate] = exitCodeFor(decision(gate), "/tmp", mode);
    reportRow[gate] = reportExitCode(gate, mode);
  }
  out(scanRow);
  out(reportRow);
}

// ---------- 2. where does `security report`'s MODE argument come from? ----------
{
  const root = await mkdtemp(path.join(tmpdir(), "t39-report-"));
  try {
    const artifacts = path.join(root, ".metaproject", "data", "security", "artifacts");
    await mkdir(artifacts, { recursive: true });
    // The workspace is configured strict...
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ mode: "ci" }),
      "utf8",
    );
    // ...but the stored artifact remembers the mode it was scanned under.
    await writeFile(
      path.join(artifacts, "latest.json"),
      JSON.stringify({
        gate: "fail",
        mode: "advisory",
        summary: { total: 1, byCategory: { secret: 1 } },
        findings: [],
        generatedAt: "2026-01-01T00:00:00Z",
      }),
      "utf8",
    );
    const report = await runReport({ cwd: root });
    const gate = await runGate({ cwd: root });
    out({
      label: "S3 `security report` folds the STORED mode, not the workspace mode",
      workspaceConfiguredMode: "ci",
      storedReportMode: report.mode,
      reportGate: report.gate,
      runGateStatus: gate.status,
      cliExitCode: reportExitCode(report.gate, report.mode),
      exitCodeIfWorkspaceModeWereUsed: reportExitCode(report.gate, "ci"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------- 3. the two health folds ----------
{
  const statuses = ["pass", "warn", "incomplete", "fail", "banana"];
  const cmdRow: Record<string, unknown> = { label: "H1 commands/health.ts runExitCode" };
  const svcRow: Record<string, unknown> = { label: "H2 health/service.ts gateExitCode" };
  for (const s of statuses) {
    cmdRow[`${s}/strict=false`] = runExitCode(s as GateStatus, false);
    cmdRow[`${s}/strict=true`] = runExitCode(s as GateStatus, true);
    svcRow[`${s}/strictWarn=false`] = gateExitCode(s as GateStatus, false);
    svcRow[`${s}/strictWarn=true`] = gateExitCode(s as GateStatus, true);
  }
  out(cmdRow);
  out(svcRow);
}

// ---------- 4. is the health service default arm REACHABLE from disk? ----------
async function healthWorkspace(latest: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t39-health-"));
  const artifacts = path.join(root, ".metaproject", "data", "health", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "latest.json"), latest, "utf8");
  return root;
}

for (const [label, body] of [
  ["H3 latest.json gate.status=banana", JSON.stringify({ gate: { status: "banana", reasons: ["r"] }, metrics: [], findings: [], sources: [] })],
  ["H4 latest.json gate.status=incomplete", JSON.stringify({ gate: { status: "incomplete", reasons: ["required source unavailable"] }, metrics: [], findings: [], sources: [] })],
  ["H5 latest.json gate.status=warn", JSON.stringify({ gate: { status: "warn", reasons: ["regression"] }, metrics: [], findings: [], sources: [] })],
  ["H6 latest.json with NO gate key at all", JSON.stringify({ metrics: [], findings: [], sources: [] })],
  ["H7 latest.json is a bare array", "[]"],
  ["H8 latest.json gate is a string", JSON.stringify({ gate: "incomplete" })],
] as const) {
  const root = await healthWorkspace(body);
  try {
    let threw: string | null = null;
    let result: unknown = null;
    try {
      result = await createCodeHealthService().gate({ cwd: root });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    out({ label, threw, result });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------- 5. the flow-completion folds: is there a fifth site? ----------
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
  const { flow, dir: created } = await service.init({ cwd: root, title: "T39 gate probe" });
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
  return service.complete({ cwd: root, id: flow.id });
}

for (const healthStatus of ["pass", "warn", "incomplete", "fail", "banana"]) {
  const root = await mkdtemp(path.join(tmpdir(), "t39-flow-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    const result = await driveToComplete(root, {
      healthGate: async () => ({ status: healthStatus, reasons: [`health says ${healthStatus}`] }),
    });
    const health = result.gates.find((g) => g.name === "health");
    out({
      label: `F1 flow complete, healthGate -> ${healthStatus}`,
      recordedGateStatus: health?.status ?? null,
      recordedDetail: health?.detail ?? null,
      completionPassed: result.passed,
    });
  } catch (e) {
    out({ label: `F1 flow complete, healthGate -> ${healthStatus}`, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const securityStatus of ["pass", "fail", "skipped"] as const) {
  const root = await mkdtemp(path.join(tmpdir(), "t39-flow-sec-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    const result = await driveToComplete(root, {
      securityGate: async () => ({ status: securityStatus, detail: `security ${securityStatus}` }),
    });
    const security = result.gates.find((g) => g.name === "security");
    out({
      label: `F2 flow complete, securityGate -> ${securityStatus}`,
      recordedGateStatus: security?.status ?? null,
      completionPassed: result.passed,
    });
  } catch (e) {
    out({ label: `F2 flow complete, securityGate -> ${securityStatus}`, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
