/**
 * T28 independent Stage-1 probe: runGate truthfulness (dispatch AC3).
 * Bounded temp fixtures only; production code is not modified.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate, runReport, createSecurityService, runScanPath } from "../../../../src/security/service";

type GateOut = { status: string; reasons: string[] };

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

function artifacts(root: string): string {
  return path.join(root, ".metaproject", "data", "security", "artifacts");
}

async function withLatest(root: string, body: string | undefined): Promise<void> {
  if (body === undefined) return;
  await mkdir(artifacts(root), { recursive: true });
  await writeFile(path.join(artifacts(root), "latest.json"), body, "utf8");
}

function emit(name: string, value: unknown): void {
  process.stdout.write(`\n=== ${name} ===\n${JSON.stringify(value, null, 2)}\n`);
}

const report = (gate: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    mode: "ci",
    gate,
    rawRetention: "off",
    summary: { total: 0, bySeverity: {}, byAction: {}, byCategory: {} },
    findings: [],
    ...extra,
  }, null, 2);

const CASES: Array<{ name: string; latest?: string }> = [
  { name: "a) no latest report at all" },
  { name: "b) malformed latest.json (truncated JSON)", latest: '{"schemaVersion": 1, "gate": "fa' },
  { name: "b2) malformed latest.json (empty file)", latest: "" },
  { name: "b3) valid JSON but not a report object", latest: '{"unrelated": true}' },
  { name: "b4) valid JSON, gate is a bogus string", latest: report("banana") },
  { name: "b5) valid JSON, gate field missing", latest: JSON.stringify({ schemaVersion: 1, summary: { total: 0 }, findings: [] }) },
  { name: "b6) latest.json is a JSON array", latest: "[]" },
  { name: "c) recognized report, gate=incomplete", latest: report("incomplete") },
  { name: "d) recognized report, gate=fail", latest: report("fail") },
  { name: "e) recognized report, gate=needs-approval", latest: report("needs-approval") },
  { name: "f) recognized report, gate=pass", latest: report("pass") },
  {
    name: "g) recognized report, gate=fail with coverage incomplete",
    latest: report("fail", { coverage: { status: "incomplete", required: true, reasons: ["file limit exceeded"] } }),
  },
  {
    name: "h) gate=pass but coverage=incomplete (inconsistent artifact)",
    latest: report("pass", { coverage: { status: "incomplete", required: true, reasons: ["unreadable or denied entry"] } }),
  },
];

const results: Array<Record<string, unknown>> = [];
for (const testCase of CASES) {
  const root = await makeRoot("t28-gate-");
  try {
    await withLatest(root, testCase.latest);
    const direct: GateOut = await runGate({ cwd: root });
    const viaService: GateOut = await createSecurityService(root).gate({ cwd: root });
    let reportGate: string | undefined;
    let reportError: string | undefined;
    try {
      reportGate = (await runReport({ cwd: root })).gate;
    } catch (error) {
      reportError = String(error);
    }
    const row = {
      case: testCase.name,
      runGate_status: direct.status,
      runGate_reasons: direct.reasons,
      service_gate_status: viaService.status,
      runReport_gate: reportGate,
      runReport_error: reportError,
      falsePassUnderStrictCI: direct.status === "pass" && testCase.name.startsWith("f)") === false,
    };
    results.push(row);
    emit(testCase.name, row);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

emit("SUMMARY runGate status per case", results.map((r) => ({ case: r.case, status: r.runGate_status, reportGate: r.runReport_gate })));

// End-to-end: a real scan that produced gate=incomplete, then runGate on the same cwd.
{
  const root = await makeRoot("t28-gate-e2e-");
  try {
    await mkdir(path.join(root, "corpus"), { recursive: true });
    await writeFile(path.join(root, "corpus", "ok.txt"), "plain\n", "utf8");
    const locked = path.join(root, "corpus", "locked.txt");
    await writeFile(locked, "x\n", "utf8");
    await (await import("node:fs/promises")).chmod(locked, 0o000);
    const scan = await runScanPath(root, {
      ownerRoot: root,
      targetPath: path.join(root, "corpus"),
      source: "trusted-project",
      path: "corpus",
    });
    const gate = await runGate({ cwd: root });
    emit("E2E scan(incomplete) -> runGate", {
      scanGate: scan.decision.gate,
      scanCoverage: scan.report.coverage,
      runGate: gate,
    });
    await (await import("node:fs/promises")).chmod(locked, 0o600).catch(() => undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Latent path: non-recursive directory scan through the programmatic API.
{
  const root = await makeRoot("t28-nonrecursive-");
  try {
    await mkdir(path.join(root, "corpus", "deep"), { recursive: true });
    await writeFile(path.join(root, "corpus", "creds.env"), "aws_access_key_id=AKIAIOSFODNN7EXAMPLE\n", "utf8");
    await writeFile(path.join(root, "corpus", "deep", "creds2.env"), "aws_access_key_id=AKIAIOSFODNN7EXAMPLE\n", "utf8");
    const scan = await runScanPath(root, {
      ownerRoot: root,
      targetPath: path.join(root, "corpus"),
      source: "trusted-project",
      path: "corpus",
      recursive: false,
    });
    const gate = await runGate({ cwd: root });
    emit("non-recursive directory scan", {
      gate: scan.decision.gate,
      coverage: scan.report.coverage,
      files: scan.report.files,
      findingCount: scan.decision.findings.length,
      runGateAfter: gate,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write("\nT28 gate probe complete\n");
