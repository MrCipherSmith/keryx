/**
 * T35 independent probe C: confirm the consumer-facing claim rather than accept
 * it -- `src/flow/service.ts` blocks completion ONLY on a `fail` status, so
 * every other status (and a vanished gate) is non-blocking. Driven through the
 * real `createFlowService().complete()` pipeline, not by reading the fold.
 *
 * Also wires the REAL `securityFlowGate` against a stored `needs-approval`
 * artifact, which is defect (5)'s end-to-end consequence.
 *
 * Read-only on production code. All fixtures under mkdtemp, removed in finally.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../../../../src/flow/service";
import type { FlowServiceDeps, TrackerAdapter } from "../../../../src/flow/types";
import { writeCleanReviewPackage } from "../../../../src/flow/review-fixtures";
import { securityFlowGate } from "../../../../src/security/guard";

const HEAD = "c0ffee1c0ffee2c0ffee3c0ffee4c0ffee5c0ffe";
let failures = 0;
const rows: Array<Record<string, unknown>> = [];

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "T", body: "B" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
  };
}

async function driveToComplete(
  root: string,
  securityGate: FlowServiceDeps["securityGate"],
): Promise<{ passed: boolean; gates: Array<{ name: string; status: string; detail: string }> }> {
  const deps: FlowServiceDeps = {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-07T10:00:00Z"),
    ...(securityGate ? { securityGate } : {}),
  };
  const service = createFlowService(deps);
  const { flow, dir: created } = await service.init({ cwd: root, title: "T35 fold probe" });
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
  return {
    passed: result.passed,
    gates: result.gates.map((g) => ({ name: g.name, status: g.status, detail: String(g.detail) })),
  };
}

async function ws(opts: { security?: boolean; mode?: string; latest?: string } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t35-flow-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (opts.security) {
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: true } } }),
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ schemaVersion: 1, mode: opts.mode ?? "ci" }),
      "utf8",
    );
  }
  if (opts.latest !== undefined) {
    const dir = path.join(root, ".metaproject", "data", "security", "artifacts");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "latest.json"), opts.latest, "utf8");
  }
  return root;
}

// --- C1: what each injected gate status does to `passed` --------------------
const INJECTED: Array<{ label: string; gate: FlowServiceDeps["securityGate"]; blocks: boolean }> = [
  { label: "null (module disabled)", gate: async () => null, blocks: false },
  { label: "pass", gate: async () => ({ status: "pass", detail: "d" }), blocks: false },
  { label: "skipped", gate: async () => ({ status: "skipped", detail: "d" }), blocks: false },
  { label: "fail", gate: async () => ({ status: "fail", detail: "d" }), blocks: true },
  {
    label: "THROWS (gate implementation error)",
    gate: async () => { throw new Error("T35-THROW-SENTINEL"); },
    blocks: false,
  },
  { label: "no securityGate dep at all", gate: undefined, blocks: false },
];

for (const injected of INJECTED) {
  const root = await ws();
  try {
    const result = await driveToComplete(root, injected.gate);
    const security = result.gates.find((g) => g.name === "security");
    const ok = result.passed === !injected.blocks;
    if (!ok) failures += 1;
    rows.push({
      case: `C1 injected securityGate = ${injected.label}`,
      passed: result.passed,
      securityGateRow: security ?? "<no security gate entry>",
      blocksCompletion: !result.passed,
      expectedToBlock: injected.blocks,
      leaksSentinel: JSON.stringify(result.gates).includes("T35-THROW-SENTINEL"),
      verdict: ok ? "OK" : "MISMATCH",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- C2: the REAL securityFlowGate, wired the way commands/flow.ts wires it --
const REAL: Array<{ label: string; opts: Parameters<typeof ws>[0]; blocks: boolean }> = [
  { label: "module disabled", opts: {}, blocks: false },
  { label: "ci + stored needs-approval", opts: { security: true, mode: "ci", latest: '{"gate":"needs-approval"}' }, blocks: true },
  { label: "ci + stored fail", opts: { security: true, mode: "ci", latest: '{"gate":"fail"}' }, blocks: true },
  { label: "ci + no stored report at all", opts: { security: true, mode: "ci" }, blocks: true },
  { label: "ci + stored pass", opts: { security: true, mode: "ci", latest: '{"gate":"pass"}' }, blocks: false },
  { label: "enforced + stored needs-approval", opts: { security: true, mode: "enforced", latest: '{"gate":"needs-approval"}' }, blocks: true },
  { label: "advisory + stored fail", opts: { security: true, mode: "advisory", latest: '{"gate":"fail"}' }, blocks: false },
  { label: "advisory + no config file (defaults)", opts: { security: true, mode: "advisory" }, blocks: false },
];

for (const testCase of REAL) {
  const root = await ws(testCase.opts);
  try {
    const direct = await securityFlowGate(root);
    const result = await driveToComplete(root, (cwd) => securityFlowGate(cwd));
    const security = result.gates.find((g) => g.name === "security");
    const ok = result.passed === !testCase.blocks;
    if (!ok) failures += 1;
    rows.push({
      case: `C2 real securityFlowGate: ${testCase.label}`,
      directGate: direct === null ? "<null: gate omitted>" : direct,
      passed: result.passed,
      securityGateRow: security ?? "<no security gate entry>",
      expectedToBlock: testCase.blocks,
      leaksRoot: JSON.stringify(result.gates).includes(root),
      verdict: ok ? "OK" : "MISMATCH",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({ probe: "T35-C flow completion fold", rows, failures }, null, 2)}\n`);
process.stdout.write(failures === 0 ? "\nT35-C: ALL CASES OK\n" : `\nT35-C: ${failures} CASE(S) MISMATCHED\n`);
process.exit(failures === 0 ? 0 : 1);
