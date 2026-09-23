// Flow 291 — `keryx governance report` integration tests: AC1 (review spend,
// not-recorded vs 0, partial coverage), AC2 (trigger spend, never
// flow-attributed), AC3 (confirmations/signatures with identity basis), AC4
// (gate outcomes surfaced from `FlowState.completionAttempts`), AC5
// (read-only), AC6 (artifact pair + shape-guarded reader), AC7 (filters),
// AC8 (--all-projects, skip missing/unreadable), AC9 (policy decisions).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FlowState } from "../flow/types";
import { appendTriggerRunRecord } from "../trigger/record";
import { registerProject } from "../lib/project-registry";
import {
  buildGovernanceReport,
  readLatestGovernanceReport,
  renderGovernanceMarkdown,
  writeGovernanceArtifacts,
} from "./report";
import { summarizeReviewSpend } from "./spend";
import type { ManagedReviewManifest } from "../review/types";

let ROOT = "";

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-governance-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

function flowDirPath(dir: string): string {
  return path.join(ROOT, ".metaproject", "flows", dir);
}

async function writeFlowFixture(dir: string, overrides: Partial<FlowState> = {}): Promise<void> {
  const base: FlowState = {
    schemaVersion: 2,
    id: dir.slice(0, 3),
    slug: dir.slice(15),
    title: `Fixture ${dir}`,
    status: "done",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    source: { type: "description", ref: null },
    acChecksum: `sha256:${"a".repeat(64)}`,
    acConfirmed: {},
    pr: { url: null },
    tasks: [{ id: "T1", title: "t", kind: "context", status: "done" }],
    history: [],
    ...overrides,
  };
  await mkdir(flowDirPath(dir), { recursive: true });
  await writeFile(path.join(flowDirPath(dir), "flow.json"), `${JSON.stringify(base, null, 2)}\n`, "utf8");
}

async function writeReviewManifest(
  flowDir: string,
  round: string,
  manifest: Partial<ManagedReviewManifest>,
): Promise<void> {
  const dir = path.join(flowDirPath(flowDir), "reviews", round);
  await mkdir(dir, { recursive: true });
  const full = { schemaVersion: 1, reviewId: round, mode: "ingest", status: "final", ...manifest };
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(full, null, 2)}\n`, "utf8");
}

// --- AC1: review spend, per-round and per-flow ------------------------------

test("AC1: summarizeReviewSpend sums only what rounds reported, never coercing absence to 0", () => {
  const manifests: ManagedReviewManifest[] = [
    { schemaVersion: 1, reviewId: "r1", mode: "ingest", status: "final", target: { kind: "pr", ref: "1" } } as unknown as ManagedReviewManifest,
    {
      schemaVersion: 1,
      reviewId: "r2",
      mode: "ingest",
      status: "final",
      target: { kind: "pr", ref: "1" },
      cost: { spent_usd: 1.5, input_tokens: 1000 },
    } as unknown as ManagedReviewManifest,
    {
      schemaVersion: 1,
      reviewId: "r3",
      mode: "ingest",
      status: "final",
      target: { kind: "pr", ref: "1" },
      cost: { spent_usd: 0.5, output_tokens: 200 },
    } as unknown as ManagedReviewManifest,
  ];

  const summary = summarizeReviewSpend(manifests);
  expect(summary.roundsTotal).toBe(3);
  expect(summary.roundsWithCost).toBe(2); // r1 has no cost at all
  expect(summary.spentUsd).toBe(2); // 1.5 + 0.5
  expect(summary.roundsWithSpentUsd).toBe(2);
  expect(summary.inputTokens).toBe(1000); // only r2 reported input tokens
  expect(summary.roundsWithInputTokens).toBe(1);
  expect(summary.outputTokens).toBe(200); // only r3 reported output tokens
  expect(summary.roundsWithOutputTokens).toBe(1);
});

test("AC1: a flow where no round ever recorded cost reports spend as not-recorded, never 0", () => {
  const summary = summarizeReviewSpend([]);
  expect(summary.roundsTotal).toBe(0);
  expect(summary.roundsWithCost).toBe(0);
  expect(summary.spentUsd).toBeUndefined();
  expect(summary.inputTokens).toBeUndefined();
  expect(summary.outputTokens).toBeUndefined();
});

test("AC1: the report aggregates review-round cost from real manifest.json files under a flow, across rounds", async () => {
  await writeFlowFixture("100-2026-01-01-review-spend-flow");
  await writeReviewManifest("100-2026-01-01-review-spend-flow", "round-1", {
    target: { kind: "pr", ref: "1" } as ManagedReviewManifest["target"],
    cost: { spent_usd: 2, input_tokens: 500, output_tokens: 100 },
  });
  await writeReviewManifest("100-2026-01-01-review-spend-flow", "round-2", {
    target: { kind: "pr", ref: "1" } as ManagedReviewManifest["target"],
    // round-2 recorded nothing — partial coverage.
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "100");
  expect(flow?.spend).toEqual({
    roundsTotal: 2,
    roundsWithCost: 1,
    spentUsd: 2,
    roundsWithSpentUsd: 1,
    inputTokens: 500,
    roundsWithInputTokens: 1,
    outputTokens: 100,
    roundsWithOutputTokens: 1,
  });
});

// --- AC2: trigger spend, project-wide, never flow-attributed ----------------

test("AC2: an absent trigger ledger reports a demonstrated $0, not an unknown", async () => {
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  expect(report.projects[0]?.triggerSpend).toEqual({ state: "absent" });
});

test("AC2: trigger spend sums recorded runs and counts unrecorded ones separately, never folding them into $0", async () => {
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "t1",
    firedBy: { kind: "event", name: "push" } as never,
    action: { kind: "reconcile" } as never,
    outcome: "ok",
    detail: "ok",
    cost: { recorded: true, usd: 1.25 },
  });
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-02T00:00:00.000Z",
    trigger: "t2",
    firedBy: { kind: "event", name: "push" } as never,
    action: { kind: "open-flow", template: "x" } as never,
    outcome: "ok",
    detail: "ok",
    cost: { recorded: false, reason: "no model call recorded" },
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  expect(report.projects[0]?.triggerSpend).toEqual({
    state: "present",
    spentUsd: 1.25,
    runsWithCostRecorded: 1,
    runsWithCostNotRecorded: 1,
    runsTotal: 2,
    // Neither record above named a flow (`dispatch` field), so nothing is attributed.
    attributedToFlowsUsd: undefined,
    openReservations: 0,
    openReservedUsd: 0,
  });
});

test("AC2: a trigger run record carries no flow reference, so project-wide spend is never folded into any flow's total", async () => {
  await writeFlowFixture("101-2026-01-01-unattributed-trigger-spend");
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "t1",
    firedBy: { kind: "event", name: "push" } as never,
    action: { kind: "reconcile" } as never,
    outcome: "ok",
    detail: "ok",
    cost: { recorded: true, usd: 9 },
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "101");
  // The flow's own review spend is unaffected by project-wide trigger spend.
  expect(flow?.spend.spentUsd).toBeUndefined();
  expect(report.projects[0]?.triggerSpend).toMatchObject({ state: "present", spentUsd: 9 });
});

// --- Flow 297 (AC1, AC2, AC3, AC4): unattended denials, dispatch attribution ---

test("AC1/AC2: a dispatch run's denials (tool, reason, time) are read from the ledger and attributed to the flow it named", async () => {
  await writeFlowFixture("120-2026-01-01-dispatch-with-denials");
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "overnight",
    firedBy: { kind: "schedule", cron: "0 2 * * *" } as never,
    action: { kind: "flow-next", flow: "120" } as never,
    outcome: "ok",
    detail: "task T1 done",
    cost: { recorded: true, usd: 0.42, tokens: { input: 100, output: 50 } },
    dispatch: {
      runId: "run-a",
      flow: "120",
      task: "T1",
      attempt: 1,
      branch: "trigger/120-T1",
      closing: "done",
      denials: [
        { tool: "shell_exec", reason: 'approval required under permission mode "ask" — unattended, so denied' },
      ],
    },
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "120");
  expect(flow?.dispatch.state).toBe("present");
  if (flow?.dispatch.state !== "present") throw new Error("unreachable");
  expect(flow.dispatch.runs).toHaveLength(1);
  const run = flow.dispatch.runs[0]!;
  expect(run).toMatchObject({ runId: "run-a", trigger: "overnight", at: "2026-01-01T00:00:00.000Z", task: "T1", outcome: "ok" });
  // Pins the source (AC3): the denial is exactly what `TriggerDispatchRecord.denials` carried, not fabricated.
  expect(run.denials).toEqual([
    { tool: "shell_exec", reason: 'approval required under permission mode "ask" — unattended, so denied' },
  ]);
  expect(flow.dispatch.spend).toEqual({
    runsTotal: 1,
    spentUsd: 0.42,
    runsWithCostRecorded: 1,
    runsWithCostNotRecorded: 0,
    openReservedUsd: 0,
    includedInProjectTriggerSpend: true,
  });

  const markdown = renderGovernanceMarkdown(report);
  expect(markdown).toContain("denied: shell_exec — approval required under permission mode");
});

// Review finding (PR #659): a dispatch run's cost was counted in
// `triggerSpend` AND in its flow's `dispatch.spend` as two UNCONNECTED
// figures — a consumer summing project + flows from `latest.json` (or a
// reader of the markdown) would double-count every dispatch dollar. Fixed by
// making the overlap explicit: `attributedToFlowsUsd` (project side) and
// `includedInProjectTriggerSpend` (flow side) — this test pins that the two
// are never additive.
test("review fix: a flow-attributed dispatch run's cost is the SAME dollar under the project total and the flow — never additive", async () => {
  await writeFlowFixture("124-2026-01-01-double-count-fix");
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "overnight",
    firedBy: { kind: "schedule", cron: "0 2 * * *" } as never,
    action: { kind: "flow-next", flow: "124" } as never,
    outcome: "ok",
    detail: "task T1 done",
    cost: { recorded: true, usd: 0.42 },
    dispatch: { runId: "run-b", flow: "124", task: "T1", closing: "done" },
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const project = report.projects[0]!;
  const flow = project.flows.find((f) => f.id === "124");
  expect(flow?.dispatch.state).toBe("present");
  if (flow?.dispatch.state !== "present") throw new Error("unreachable");

  // The project's total IS the true total ($0.42 — one run, nothing else fired).
  expect(project.triggerSpend).toMatchObject({ state: "present", spentUsd: 0.42 });
  if (project.triggerSpend.state !== "present") throw new Error("unreachable");
  // The attributed part equals the whole total here — everything that fired named this flow.
  expect(project.triggerSpend.attributedToFlowsUsd).toBe(0.42);
  // The flow's own figure carries the explicit "this is a slice, not an addition" flag.
  expect(flow.dispatch.spend.includedInProjectTriggerSpend).toBe(true);
  expect(flow.dispatch.spend.spentUsd).toBe(0.42);

  // The double-count a naive consumer would compute — project + every flow's
  // dispatch spend — must NOT equal what the report presents as the total.
  // It must instead equal spentUsd + attributedToFlowsUsd, proving the two
  // figures overlap rather than sum.
  const naiveDoubleCount = project.triggerSpend.spentUsd + flow.dispatch.spend.spentUsd!;
  expect(naiveDoubleCount).toBe(0.84);
  expect(naiveDoubleCount).not.toBe(project.triggerSpend.spentUsd); // the double-count is wrong…
  expect(project.triggerSpend.spentUsd).toBe(0.42); // …the report's own total is the true, non-doubled figure

  // Markdown makes the non-additivity explicit in both directions.
  const markdown = renderGovernanceMarkdown(report);
  expect(markdown).toContain("of which $0.42 is shown under flows");
  expect(markdown).toMatch(/not additive/i);
  expect(markdown).toContain("included in the project's trigger spend");
});

test("AC2/AC4: an open spend reservation is shown as reserved, not spent — never folded into spentUsd", async () => {
  await writeFlowFixture("121-2026-01-01-open-reservation");
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "overnight",
    firedBy: { kind: "schedule", cron: "0 2 * * *" } as never,
    action: { kind: "flow-next", flow: "121" } as never,
    outcome: "reserved",
    detail: "reserved $1 for dispatch run run-killed before its first model call",
    cost: { recorded: false, reason: "a reservation — the run's own record carries what it spent" },
    reservation: { runId: "run-killed", usd: 1 },
    dispatch: { runId: "run-killed", flow: "121", task: "T1" },
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "121");
  expect(flow?.dispatch.state).toBe("present");
  if (flow?.dispatch.state !== "present") throw new Error("unreachable");
  // No closing record yet — this is not a "run" in the closed sense.
  expect(flow.dispatch.runs).toEqual([]);
  expect(flow.dispatch.openReservations).toEqual([
    { runId: "run-killed", trigger: "overnight", at: "2026-01-01T00:00:00.000Z", usd: 1 },
  ]);
  expect(flow.dispatch.spend.spentUsd).toBeUndefined(); // never folded in as spent
  expect(flow.dispatch.spend.openReservedUsd).toBe(1);
  expect(flow.dispatch.spend.runsTotal).toBe(1);

  const markdown = renderGovernanceMarkdown(report);
  expect(markdown).toContain("reserved, not spent");
});

test("AC4: a report-only flow-next run (no `dispatch` block) stays project-level, never attributed to the flow it named", async () => {
  await writeFlowFixture("122-2026-01-01-report-only");
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "on-merge",
    firedBy: { kind: "event", name: "post-merge" } as never,
    action: { kind: "flow-next", flow: "122" } as never,
    outcome: "ok",
    detail: "flow 122's next task is T1",
    cost: { recorded: false, reason: "this action does not call a model — reconcile/rebuild are deterministic, no spend to record" },
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "122");
  expect(flow?.dispatch.state).toBe("present");
  if (flow?.dispatch.state !== "present") throw new Error("unreachable");
  // No `dispatch` on the record at all (report-only never writes one) — it never attaches to this flow.
  expect(flow.dispatch.runs).toEqual([]);
  expect(flow.dispatch.openReservations).toEqual([]);
  // Still counted at the project level, exactly as before this change.
  expect(report.projects[0]?.triggerSpend).toMatchObject({ state: "present", runsWithCostNotRecorded: 1, runsTotal: 1 });
});

test("AC4: a record written before this change (a 'reserved' line with no `dispatch` block) still reads, and stays unattributed rather than guessed onto a flow", async () => {
  await writeFlowFixture("123-2026-01-01-pre-change-record");
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "overnight",
    firedBy: { kind: "schedule", cron: "0 2 * * *" } as never,
    action: { kind: "flow-next", flow: "123" } as never,
    outcome: "reserved",
    detail: "reserved $1 for dispatch run pre-change-run before its first model call",
    cost: { recorded: false, reason: "a reservation — the run's own record carries what it spent" },
    reservation: { runId: "pre-change-run", usd: 1 },
    // No `dispatch` field — exactly what every "reserved" record looked like before flow 297.
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "123");
  expect(flow?.dispatch.state).toBe("present");
  if (flow?.dispatch.state !== "present") throw new Error("unreachable");
  expect(flow.dispatch.openReservations).toEqual([]); // unattributable — never guessed onto this flow
  expect(flow.dispatch.runs).toEqual([]);
  // Still visible at the project level — since flow 300 (N8) under its own
  // name, an OPEN reservation, not as a run whose cost was "not recorded".
  expect(report.projects[0]?.triggerSpend).toMatchObject({
    state: "present",
    runsWithCostNotRecorded: 0,
    openReservations: 1,
    openReservedUsd: 1,
    runsTotal: 1,
  });
});

test("AC1/AC3: policy decisions are narrowed to interactive sessions — the report no longer calls flow 290 a future source", async () => {
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const reason = report.projects[0]?.policyDecisions.reason ?? "";
  expect(reason).not.toContain("future source");
  expect(reason.toLowerCase()).toContain("interactive session");
});

// --- AC3: confirmations, signatures, identity basis --------------------------

test("AC3: a flow with no signatures field at all reports confirmations as not recorded (predates signing)", async () => {
  await writeFlowFixture("102-2026-01-01-predates-signing", {
    acConfirmed: { AC1: { at: "2026-01-01T00:00:00.000Z" } },
  });
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "102");
  expect(flow?.confirmations).toEqual({ recorded: false });
});

test("AC3: confirmations join acConfirmed with the matching ac-confirm signature, identity basis included; unmatched confirmations show identity undefined, never a fabricated verified confirmer", async () => {
  await writeFlowFixture("103-2026-01-01-joined-confirmations", {
    acConfirmed: {
      AC1: { at: "2026-01-01T00:00:00.000Z" },
      AC2: { at: "2026-01-01T00:05:00.000Z" }, // no matching signature below
    },
    signatures: [
      {
        at: "2026-01-01T00:00:00.000Z",
        kind: "ac-confirm",
        criterion: "AC1",
        identity: { value: "Aleks", basis: "stated", source: "`--signed-by` flag" },
        acChecksum: `sha256:${"a".repeat(64)}`,
      },
      {
        at: "2026-01-01T01:00:00.000Z",
        kind: "complete",
        identity: { value: "Aleks", basis: "stated", source: "`--signed-by` flag" },
        acChecksum: `sha256:${"a".repeat(64)}`,
        headCommit: "deadbeef",
      },
    ],
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "103");
  expect(flow?.confirmations.recorded).toBe(true);
  if (!flow?.confirmations.recorded) throw new Error("unreachable");
  const ac1 = flow.confirmations.criteria.find((c) => c.criterion === "AC1");
  expect(ac1?.identity).toEqual({ value: "Aleks", basis: "stated", source: "`--signed-by` flag" });
  const ac2 = flow.confirmations.criteria.find((c) => c.criterion === "AC2");
  expect(ac2?.identity).toBeUndefined(); // never presented as verified
  expect(flow.confirmations.completionSignature?.identity.value).toBe("Aleks");
  expect(flow.confirmations.completionSignature?.headCommit).toBe("deadbeef");
});

// --- AC4: gate outcomes ------------------------------------------------------

test("AC4: a flow with no completionAttempts reports gate outcomes as not recorded", async () => {
  await writeFlowFixture("104-2026-01-01-no-completion-attempts");
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "104");
  expect(flow?.gateOutcomes).toEqual({ recorded: false });
});

test("AC4: every recorded completion attempt (pass or fail) is surfaced, with every gate it evaluated", async () => {
  await writeFlowFixture("105-2026-01-01-completion-attempts", {
    completionAttempts: [
      {
        at: "2026-01-01T00:00:00.000Z",
        passed: false,
        acChecksum: null,
        gates: [{ name: "acceptance-criteria", status: "fail", detail: "unconfirmed: AC1" }],
      },
      {
        at: "2026-01-01T01:00:00.000Z",
        passed: true,
        acChecksum: null,
        gates: [
          { name: "acceptance-criteria", status: "pass", detail: "1 confirmed" },
          { name: "owner", status: "skipped", detail: "not enabled" },
        ],
      },
    ],
  });
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const flow = report.projects[0]?.flows.find((f) => f.id === "105");
  expect(flow?.gateOutcomes.recorded).toBe(true);
  if (!flow?.gateOutcomes.recorded) throw new Error("unreachable");
  expect(flow.gateOutcomes.attempts).toHaveLength(2);
  expect(flow.gateOutcomes.attempts[0]?.passed).toBe(false);
  expect(flow.gateOutcomes.attempts[1]?.passed).toBe(true);
  expect(flow.gateOutcomes.attempts[1]?.gates).toHaveLength(2);
});

// --- AC5: read-only -----------------------------------------------------------

test("AC5: building and writing the report never modifies anything under .metaproject/flows or .metaproject/data/trigger", async () => {
  await writeFlowFixture("106-2026-01-01-read-only-check");
  await writeReviewManifest("106-2026-01-01-read-only-check", "round-1", {
    target: { kind: "pr", ref: "1" } as ManagedReviewManifest["target"],
    cost: { spent_usd: 1 },
  });
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "t1",
    firedBy: { kind: "event", name: "push" } as never,
    action: { kind: "reconcile" } as never,
    outcome: "ok",
    detail: "ok",
    cost: { recorded: true, usd: 1 },
  });

  const flowJsonPath = path.join(flowDirPath("106-2026-01-01-read-only-check"), "flow.json");
  const manifestPath = path.join(
    flowDirPath("106-2026-01-01-read-only-check"),
    "reviews",
    "round-1",
    "manifest.json",
  );
  const runsPath = path.join(ROOT, ".metaproject", "data", "trigger", "runs.jsonl");

  const before = {
    flow: await readFile(flowJsonPath, "utf8"),
    manifest: await readFile(manifestPath, "utf8"),
    runs: await readFile(runsPath, "utf8"),
    flowMtime: (await stat(flowJsonPath)).mtimeMs,
  };

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  await writeGovernanceArtifacts(ROOT, report);

  const after = {
    flow: await readFile(flowJsonPath, "utf8"),
    manifest: await readFile(manifestPath, "utf8"),
    runs: await readFile(runsPath, "utf8"),
  };
  expect(after).toEqual({ flow: before.flow, manifest: before.manifest, runs: before.runs });
});

// --- AC6: artifact pair, schema-versioned, shape-guarded reader --------------

test("AC6: writing the report produces latest.md and a schema-versioned latest.json, both readable back", async () => {
  await writeFlowFixture("107-2026-01-01-artifact-pair");
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const written = await writeGovernanceArtifacts(ROOT, report);

  expect(written.markdownPath).toBe(path.join(ROOT, ".metaproject", "data", "governance", "artifacts", "latest.md"));
  expect(written.jsonPath).toBe(path.join(ROOT, ".metaproject", "data", "governance", "artifacts", "latest.json"));

  const markdown = await readFile(written.markdownPath, "utf8");
  expect(markdown).toContain("# Governance report");

  const read = await readLatestGovernanceReport(ROOT);
  expect(read.state).toBe("present");
  if (read.state !== "present") throw new Error("unreachable");
  expect(read.report.schemaVersion).toBe(1);
});

test("AC6: no report yet reads as absent, never a crash", async () => {
  const read = await readLatestGovernanceReport(ROOT);
  expect(read).toEqual({ state: "absent" });
});

test("AC6: a malformed stored report reads as malformed, not a crash and not an empty valid report", async () => {
  const artifacts = path.join(ROOT, ".metaproject", "data", "governance", "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "latest.json"), "not json at all", "utf8");
  const read = await readLatestGovernanceReport(ROOT);
  expect(read.state).toBe("malformed");
});

// --- AC7: filters --------------------------------------------------------------

test("AC7: --flow narrows to the one flow", async () => {
  await writeFlowFixture("108-2026-01-01-filter-a");
  await writeFlowFixture("109-2026-01-01-filter-b");
  const report = await buildGovernanceReport({
    cwd: ROOT,
    filters: { flow: "108" },
    allProjects: false,
    now: () => new Date(),
  });
  expect(report.projects[0]?.flows.map((f) => f.id)).toEqual(["108"]);
});

test("AC7: --owner narrows to flows with that exact owner, excluding flows with no owner", async () => {
  await writeFlowFixture("110-2026-01-01-owner-a", { owner: { value: "Aleks", basis: "stated", source: "x" } });
  await writeFlowFixture("111-2026-01-01-owner-b", { owner: { value: "Priya", basis: "stated", source: "x" } });
  await writeFlowFixture("112-2026-01-01-owner-none");
  const report = await buildGovernanceReport({
    cwd: ROOT,
    filters: { owner: "Aleks" },
    allProjects: false,
    now: () => new Date(),
  });
  expect(report.projects[0]?.flows.map((f) => f.id)).toEqual(["110"]);
});

test("AC7: --since/--until narrow by each flow's own updatedAt", async () => {
  await writeFlowFixture("113-2026-01-01-early", { updatedAt: "2026-01-01T00:00:00.000Z" });
  await writeFlowFixture("114-2026-01-01-mid", { updatedAt: "2026-02-01T00:00:00.000Z" });
  await writeFlowFixture("115-2026-01-01-late", { updatedAt: "2026-03-01T00:00:00.000Z" });
  const report = await buildGovernanceReport({
    cwd: ROOT,
    filters: { since: "2026-01-15T00:00:00.000Z", until: "2026-02-15T00:00:00.000Z" },
    allProjects: false,
    now: () => new Date(),
  });
  expect(report.projects[0]?.flows.map((f) => f.id)).toEqual(["114"]);
});

// --- AC8: --all-projects -------------------------------------------------------

test("AC8: --all-projects covers the current project plus every registered project; a missing one is listed skipped, never failing the whole report", async () => {
  await writeFlowFixture("116-2026-01-01-current-project-flow");

  const other = await mkdtemp(path.join(tmpdir(), "keryx-governance-other-"));
  await mkdir(path.join(other, ".metaproject"), { recursive: true });
  await mkdir(path.join(other, ".metaproject", "flows", "200-2026-01-01-other-project-flow"), { recursive: true });
  await writeFile(
    path.join(other, ".metaproject", "flows", "200-2026-01-01-other-project-flow", "flow.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        id: "200",
        slug: "other-project-flow",
        title: "Other project flow",
        status: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        source: { type: "description", ref: null },
        acChecksum: null,
        acConfirmed: {},
        pr: { url: null },
        tasks: [],
        history: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const registryDir = await mkdtemp(path.join(tmpdir(), "keryx-governance-registry-"));
  // Registration itself requires an initialized project to exist, so the
  // "went missing later" case is built by registering a real one and then
  // removing it — a registered project whose path no longer exists on disk,
  // exactly like an unmounted or deleted checkout.
  const missing = await mkdtemp(path.join(tmpdir(), "keryx-governance-missing-"));
  await mkdir(path.join(missing, ".metaproject"), { recursive: true });
  registerProject(other, { dir: registryDir, displayName: "other" });
  registerProject(missing, { dir: registryDir, displayName: "missing" });
  await rm(missing, { recursive: true, force: true });

  const report = await buildGovernanceReport({
    cwd: ROOT,
    filters: {},
    allProjects: true,
    now: () => new Date(),
    registryDir,
  });

  const currentEntry = report.projects.find((p) => p.root === ROOT);
  const otherEntry = report.projects.find((p) => p.root === other);
  expect(currentEntry?.flows.map((f) => f.id)).toEqual(["116"]);
  expect(otherEntry?.state).toBe("ok");
  expect(otherEntry?.flows.map((f) => f.id)).toEqual(["200"]);
  // The registered-but-missing project is listed with a reason, never dropped
  // and never failing the whole report.
  const skipped = report.projects.filter((p) => p.state === "skipped");
  expect(skipped.length).toBeGreaterThan(0);
  expect(skipped.every((p) => typeof p.reason === "string" && p.reason.length > 0)).toBe(true);

  await rm(other, { recursive: true, force: true });
  await rm(registryDir, { recursive: true, force: true });
});

// --- AC9: policy decisions -----------------------------------------------------

test("AC9: policy allow/ask/deny decisions are reported as not recorded, with a reason, never omitted", async () => {
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  expect(report.projects[0]?.policyDecisions.recorded).toBe(false);
  expect(report.projects[0]?.policyDecisions.reason).toContain("no durable log");
});

// --- Markdown rendering sanity -------------------------------------------------

test("markdown rendering never prints a bare 0 for an unrecorded figure", async () => {
  await writeFlowFixture("117-2026-01-01-markdown-check");
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const markdown = renderGovernanceMarkdown(report);
  expect(markdown).toContain("spent=not recorded");
  expect(markdown).toContain("gate outcomes: not recorded");
  expect(markdown).toContain("confirmations: not recorded (predates signing)");
});

test("review-fix: trigger spend is formatted through the same usd() rounding as review spend, not printed raw", async () => {
  // A classic float-sum artifact (0.1 + 0.2 === 0.30000000000000004 in IEEE
  // 754) — printed raw, this is exactly the kind of figure a reader would
  // (rightly) distrust. It must come out trimmed, the same way review
  // spend's `usd()` formatter trims it.
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-01T00:00:00.000Z",
    trigger: "t1",
    firedBy: { kind: "event", name: "push" } as never,
    action: { kind: "reconcile" } as never,
    outcome: "ok",
    detail: "ok",
    cost: { recorded: true, usd: 0.1 },
  });
  await appendTriggerRunRecord(ROOT, {
    at: "2026-01-02T00:00:00.000Z",
    trigger: "t2",
    firedBy: { kind: "event", name: "push" } as never,
    action: { kind: "reconcile" } as never,
    outcome: "ok",
    detail: "ok",
    cost: { recorded: true, usd: 0.2 },
  });

  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const markdown = renderGovernanceMarkdown(report);
  expect(markdown).toContain("$0.3 across 2 run(s) with recorded cost");
  expect(markdown).not.toContain("0.30000000000000004");
});

// --- Flow 300 review F3: a reservation hold is not a run once something closed it ---

test("F3: a dispatch whose closing record carries a cost is ONE run with cost recorded — its reservation hold is not counted as 'not recorded'", async () => {
  const hold = {
    trigger: "work",
    firedBy: { kind: "event", event: "ci" } as never,
    action: { kind: "flow-next", flow: "001" } as never,
  };
  await appendTriggerRunRecord(ROOT, {
    ...hold,
    at: "2026-01-01T00:00:00.000Z",
    outcome: "reserved",
    detail: "reserved $1",
    cost: { recorded: false, reason: "a reservation — the run's own record carries what it spent" },
    reservation: { runId: "run-a", usd: 1 },
  });
  await appendTriggerRunRecord(ROOT, {
    ...hold,
    at: "2026-01-01T00:05:00.000Z",
    outcome: "ok",
    detail: "done",
    cost: { recorded: true, usd: 0.004 },
    dispatch: { runId: "run-a", flow: "001" },
  });
  // A killed run the operator closed: its resolution is the run's closing record.
  await appendTriggerRunRecord(ROOT, {
    ...hold,
    at: "2026-01-02T00:00:00.000Z",
    outcome: "reserved",
    detail: "reserved $1",
    cost: { recorded: false, reason: "a reservation" },
    reservation: { runId: "run-b", usd: 1 },
  });
  await appendTriggerRunRecord(ROOT, {
    ...hold,
    at: "2026-01-02T01:00:00.000Z",
    outcome: "reservation-resolved",
    detail: "operator closed run run-b's reservation",
    cost: { recorded: true, usd: 0.5 },
    resolves: "run-b",
  });
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  expect(report.projects[0]?.triggerSpend).toMatchObject({
    state: "present",
    spentUsd: 0.504,
    runsWithCostRecorded: 2,
    runsWithCostNotRecorded: 0,
    runsTotal: 2,
  });
});

test("F3/N8: a hold nothing has closed yet (in flight, or killed and unresolved) still counts as one run — an OPEN one, not 'not recorded'", async () => {
  await appendTriggerRunRecord(ROOT, {
    trigger: "work",
    firedBy: { kind: "event", event: "ci" } as never,
    action: { kind: "flow-next", flow: "001" } as never,
    at: "2026-01-01T00:00:00.000Z",
    outcome: "reserved",
    detail: "reserved $1",
    cost: { recorded: false, reason: "a reservation" },
    reservation: { runId: "run-open", usd: 1 },
  });
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  expect(report.projects[0]?.triggerSpend).toMatchObject({ state: "present", runsWithCostNotRecorded: 0, openReservations: 1, openReservedUsd: 1, runsTotal: 1 });
});

// --- Flow 300 review F8: artifacts are replaced atomically, latest.json last ---

test("F8: when latest.md cannot be replaced, latest.json is left exactly as it was — it is written LAST — and no temp file is left behind", async () => {
  const dir = path.join(ROOT, ".metaproject", "data", "governance", "artifacts");
  const first = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date("2026-01-01T00:00:00.000Z") });
  await writeGovernanceArtifacts(ROOT, first);
  const before = await readFile(path.join(dir, "latest.json"), "utf8");
  // Make the markdown target un-replaceable: a non-empty directory where the file goes.
  await rm(path.join(dir, "latest.md"));
  await mkdir(path.join(dir, "latest.md", "blocker"), { recursive: true });
  const second = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date("2026-02-02T00:00:00.000Z") });
  await expect(writeGovernanceArtifacts(ROOT, second)).rejects.toThrow();
  expect(await readFile(path.join(dir, "latest.json"), "utf8")).toBe(before);
  expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

// --- Flow 300 N8: one fact, one name — an open reservation is "open" at project level AND in the flow view ---

async function reserve(runId: string, flow: string, at: string, usd = 1): Promise<void> {
  await appendTriggerRunRecord(ROOT, {
    trigger: "work",
    firedBy: { kind: "event", event: "ci" } as never,
    action: { kind: "flow-next", flow } as never,
    at,
    outcome: "reserved",
    detail: `reserved $${usd}`,
    cost: { recorded: false, reason: "a reservation — the run's own record carries what it spent" },
    reservation: { runId, usd },
    dispatch: { runId, flow },
  });
}

async function spendFor(flowId: string) {
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  const project = report.projects[0]?.triggerSpend;
  const flow = report.projects[0]?.flows.find((f) => f.id === flowId);
  if (flow?.dispatch.state !== "present") throw new Error("flow dispatch view not present");
  return { project, dispatch: flow.dispatch, markdown: renderGovernanceMarkdown(report) };
}

test("N8: reserved → CLOSED by the run: one run with its cost, zero open — the same in the project figure and the flow view", async () => {
  await writeFlowFixture("201-2026-01-01-n8-closed");
  await reserve("run-c", "201", "2026-01-01T00:00:00.000Z");
  await appendTriggerRunRecord(ROOT, {
    trigger: "work",
    firedBy: { kind: "event", event: "ci" } as never,
    action: { kind: "flow-next", flow: "201" } as never,
    at: "2026-01-01T00:10:00.000Z",
    outcome: "ok",
    detail: "done",
    cost: { recorded: true, usd: 0.3 },
    dispatch: { runId: "run-c", flow: "201" },
  });
  const { project, dispatch } = await spendFor("201");
  expect(project).toMatchObject({ runsTotal: 1, runsWithCostRecorded: 1, runsWithCostNotRecorded: 0, openReservations: 0, openReservedUsd: 0, spentUsd: 0.3, attributedToFlowsUsd: 0.3 });
  expect(dispatch.spend).toMatchObject({ runsTotal: 1, runsWithCostRecorded: 1, runsWithCostNotRecorded: 0, openReservedUsd: 0, spentUsd: 0.3 });
  expect(dispatch.openReservations).toEqual([]);
});

test("N8: reserved → RESOLVED by the operator (killed run): the resolution is the run's closing record in BOTH views, zero open", async () => {
  await writeFlowFixture("202-2026-01-01-n8-resolved");
  await reserve("run-r", "202", "2026-01-01T00:00:00.000Z");
  await appendTriggerRunRecord(ROOT, {
    trigger: "work",
    firedBy: { kind: "event", event: "ci" } as never,
    action: { kind: "flow-next", flow: "202" } as never,
    at: "2026-01-02T00:00:00.000Z",
    outcome: "reservation-resolved",
    detail: "operator closed run run-r's reservation",
    cost: { recorded: true, usd: 0.7 },
    resolves: "run-r",
  });
  const { project, dispatch } = await spendFor("202");
  expect(project).toMatchObject({ runsTotal: 1, runsWithCostRecorded: 1, openReservations: 0, openReservedUsd: 0, spentUsd: 0.7, attributedToFlowsUsd: 0.7 });
  expect(dispatch.spend).toMatchObject({ runsTotal: 1, runsWithCostRecorded: 1, openReservedUsd: 0, spentUsd: 0.7 });
  expect(dispatch.runs.map((r) => [r.runId, r.outcome])).toEqual([["run-r", "reservation-resolved"]]);
  expect(dispatch.openReservations).toEqual([]);
});

test("N8: reserved → still OPEN (in flight, or killed and never resolved): 'open' in both views, never 'not recorded', never spent, still in the total — included, not additive", async () => {
  await writeFlowFixture("203-2026-01-01-n8-open");
  await reserve("run-o", "203", "2026-01-01T00:00:00.000Z", 1.5);
  const { project, dispatch, markdown } = await spendFor("203");
  expect(project).toMatchObject({
    runsTotal: 1,
    runsWithCostRecorded: 0,
    runsWithCostNotRecorded: 0,
    openReservations: 1,
    openReservedUsd: 1.5,
    spentUsd: 0,
    attributedToFlowsUsd: undefined,
  });
  expect(dispatch.spend).toMatchObject({ runsTotal: 1, runsWithCostNotRecorded: 0, openReservedUsd: 1.5, spentUsd: undefined, includedInProjectTriggerSpend: true });
  expect(dispatch.openReservations.map((r) => r.runId)).toEqual(["run-o"]);
  // The markdown names it the same way at both levels.
  expect(markdown).toContain("0 run(s) fired with cost not recorded (never counted as $0); 1 open reservation(s) totaling $1.5 (reserved, not spent");
  expect(markdown).toContain("1 run(s) total (1 open)");
  expect(markdown).toContain("1 open reservation(s) totaling $1.5 (reserved, not spent); 1 run(s) total (included in the project's trigger spend above — not additive)");
});
