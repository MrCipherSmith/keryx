// T62 probe — row 1. Independent recheck of T60's repair (T57 F-001).
//
// Difference from T57-flow.ts, deliberately: this probe does NOT stub
// `healthGate`. It writes a REAL `.metaproject/data/health/artifacts/latest.json`
// and uses the production wiring `flowServiceDeps()` builds
// (`createCodeHealthService().gate`), so the value that reaches
// `healthGateOutcome` is produced by the real health service, not by the probe.
// It also captures the text actually handed to `tracker.comment(...)` — the
// PUBLISHED comment — rather than only `result.issueComment`.
//
// Read-only against production code; every fixture is `mkdtemp`, removed in
// `finally`.
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../../../../src/flow/service";
import { createCodeHealthService } from "../../../../src/health/service";
import { writeCleanReviewPackage } from "../../../../src/flow/review-fixtures";
import type { FlowServiceDeps, TrackerAdapter } from "../../../../src/flow/types";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);
const HEAD = "c0ffee1c0ffee2c0ffee3c0ffee4c0ffee5c0ffe";
const ISSUE = "https://github.com/acme/app/issues/7";

type Published = { text: string | null };

function capturingTracker(published: Published): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => ({ owner: "acme", repo: "app", number: 7 }) as never,
    fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async (_ref: unknown, body: string) => {
      published.text = body;
      return true;
    },
  } as unknown as TrackerAdapter;
}

// A real stored health report, shaped so it passes `hasGateShape`.
async function writeHealthLatest(
  root: string,
  gate: { status: string; reasons: string[] },
): Promise<void> {
  const dir = path.join(root, ".metaproject", "data", "health", "artifacts");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "latest.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-07-07T09:00:00Z",
      gate,
      metrics: [],
      sources: [],
      findings: [],
    }),
    "utf8",
  );
}

async function driveToComplete(
  root: string,
  overrides: Partial<FlowServiceDeps>,
): Promise<{ result: Awaited<ReturnType<ReturnType<typeof createFlowService>["complete"]>>; stored: Record<string, unknown>; published: Published }> {
  const published: Published = { text: null };
  const full: FlowServiceDeps = {
    tracker: capturingTracker(published),
    // THE PRODUCTION WIRING, copied from `src/commands/flow.ts:flowServiceDeps()`
    healthGate: async (cwd: string) => {
      const result = await createCodeHealthService().gate({ cwd });
      return { status: result.status, reasons: result.reasons };
    },
    now: () => new Date("2026-07-07T10:00:00Z"),
    ...overrides,
  } as FlowServiceDeps;
  const service = createFlowService(full);
  const { flow, dir: created } = await service.init({
    cwd: root,
    title: "T62 gate probe",
    issue: ISSUE,
  } as never);
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
  const result = await service.complete({ cwd: root, id: flow.id, comment: true } as never);
  const stored = JSON.parse(
    await readFile(
      path.join(root, ".metaproject", "flows", path.basename(created), "flow.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return { result, stored, published };
}

const SECRET = "AKIAIOSFODNN7EXAMPLE";

// ---------------------------------------------------------------------------
// R1: through the REAL health service. A stored report whose gate is `warn`
// must reach flow.json and the PUBLISHED comment as something other than a
// clean pass; a stored `pass` must be byte-identical to the pre-fix constant.
// ---------------------------------------------------------------------------
const REAL_CASES: [string, { status: string; reasons: string[] }][] = [
  ["R01 real health report gate=pass", { status: "pass", reasons: ["PASS: no gate conditions triggered"] }],
  ["R02 real health report gate=warn", { status: "warn", reasons: [`WARN: coverage 41% below soft floor 60% ${SECRET}`] }],
  ["R03 real health report gate=incomplete", { status: "incomplete", reasons: ["INCOMPLETE: required source unavailable: eslint"] }],
  ["R04 real health report gate=fail", { status: "fail", reasons: ["FAIL: 3 finding(s) at P0"] }],
  ["R05 real health report gate=banana", { status: "banana", reasons: [`planted ${SECRET}`] }],
];

const realStored: Record<string, string> = {};
const realPublished: Record<string, string> = {};

for (const [label, gate] of REAL_CASES) {
  const root = await mkdtemp(path.join(tmpdir(), "t62-flow-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    await writeHealthLatest(root, gate);
    const { result, stored, published } = await driveToComplete(root, {});
    const row = result.gates.find((g) => g.name === "health");
    const history = (stored.history as { event: string; detail?: string }[]) ?? [];
    const storedJson = JSON.stringify(stored);
    realStored[gate.status] = storedJson;
    realPublished[gate.status] = published.text ?? "";
    out({
      label,
      returnedGateStatus: row?.status ?? null,
      returnedDetail: row?.detail ?? null,
      completionPassed: result.passed,
      storedFlowStatus: stored.status,
      storedHistoryTail: history.slice(-1).map((h) => `${h.event}: ${h.detail ?? ""}`),
      publishedComment: published.text,
      publishedHealthLine: published.text?.split("\n").find((l) => l.includes("Gates")) ?? null,
      publishedSaysCleanPass: /health: pass/.test(published.text ?? ""),
      storedSaysBareAllGatesPassed: /"detail": ?"all gates passed"/.test(storedJson),
      leakedSecret: storedJson.includes(SECRET) || (published.text ?? "").includes(SECRET),
    });
  } catch (e) {
    out({ label, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

out({
  label: "R99 real-service pass vs warn, durable + published",
  storedRecordsIdentical: realStored.pass === realStored.warn,
  publishedCommentsIdentical: realPublished.pass === realPublished.warn,
  passStoredContainsWarn: /warn/i.test(realStored.pass ?? ""),
  warnStoredContainsWarn: /warn/i.test(realStored.warn ?? ""),
  passPublishedHealthLine:
    (realPublished.pass ?? "").split("\n").find((l) => l.includes("Gates")) ?? null,
  warnPublishedHealthLine:
    (realPublished.warn ?? "").split("\n").find((l) => l.includes("Gates")) ?? null,
});

// ---------------------------------------------------------------------------
// R2: the completion fold itself must not have moved. Drive the same set of
// health statuses through a STUBBED dep (matching T57's C-rows) and record
// `passed` + the stored status for each, so "which flows complete" is measured
// directly rather than inferred.
// ---------------------------------------------------------------------------
const FOLD_CASES: [string, unknown][] = [
  ["S01 pass", "pass"],
  ["S02 warn", "warn"],
  ["S03 incomplete", "incomplete"],
  ["S04 fail", "fail"],
  ["S05 banana", "banana"],
  ["S06 empty string", ""],
  ["S07 PASS upper", "PASS"],
  ["S08 'warn ' trailing space", "warn "],
  ["S09 skipped", "skipped"],
  ["S10 null", null],
  ["S11 undefined", undefined],
  ["S12 true", true],
  ["S13 ['warn']", ["warn"]],
];

for (const [label, status] of FOLD_CASES) {
  const root = await mkdtemp(path.join(tmpdir(), "t62-fold-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    const { result, stored, published } = await driveToComplete(root, {
      healthGate: (async () => ({ status, reasons: [`planted ${SECRET}`] })) as never,
    });
    const row = result.gates.find((g) => g.name === "health");
    const history = (stored.history as { event: string; detail?: string }[]) ?? [];
    out({
      label,
      returnedGateStatus: row?.status ?? null,
      returnedDetail: row?.detail ?? null,
      completionPassed: result.passed,
      storedFlowStatus: stored.status,
      storedHistoryTail: history.slice(-1).map((h) => `${h.event}: ${h.detail ?? ""}`),
      publishedHealthLine: published.text?.split("\n").find((l) => l.includes("Gates")) ?? null,
      leakedSecret:
        JSON.stringify(stored).includes(SECRET) || (published.text ?? "").includes(SECRET),
    });
  } catch (e) {
    out({ label, error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// R3: attack — can a `warn` be laundered back into an indistinguishable record?
// The distinguishing mechanism is a string comparison against the literal
// "health gate: pass". Drive a dep whose status is `warn` but check every
// surface; and drive one whose status is `pass` while a SECOND gate named
// "health" is impossible — confirm the `find` picks the real one.
// ---------------------------------------------------------------------------
{
  const root = await mkdtemp(path.join(tmpdir(), "t62-launder-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    // A security gate that returns a `detail` containing the literal
    // "health gate: pass" must not affect the health row.
    const { result, stored, published } = await driveToComplete(root, {
      healthGate: (async () => ({ status: "warn", reasons: [] })) as never,
      securityGate: (async () => ({ status: "pass", detail: "health gate: pass" })) as never,
    });
    const history = (stored.history as { event: string; detail?: string }[]) ?? [];
    out({
      label: "R91 warn health beside a security gate whose detail mimics the pass literal",
      completionPassed: result.passed,
      storedHistoryTail: history.slice(-1).map((h) => `${h.event}: ${h.detail ?? ""}`),
      publishedHealthLine: published.text?.split("\n").find((l) => l.includes("Gates")) ?? null,
      distinguishable: /warn/i.test(JSON.stringify(stored)) && /warn/i.test(published.text ?? ""),
    });
  } catch (e) {
    out({ label: "R91", error: e instanceof Error ? e.message : String(e) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
