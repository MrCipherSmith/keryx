// Flow 291 — `keryx governance report` integration tests: AC1 (review spend,
// not-recorded vs 0, partial coverage), AC2 (trigger spend, never
// flow-attributed), AC3 (confirmations/signatures with identity basis), AC4
// (gate outcomes surfaced from `FlowState.completionAttempts`), AC5
// (read-only), AC6 (artifact pair + shape-guarded reader), AC7 (filters),
// AC8 (--all-projects, skip missing/unreadable), AC9 (policy decisions).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FlowState } from "../flow/types";
import { appendTriggerRunRecord } from "../trigger/record";
import { addConfirmedSchedule } from "../trigger/store";
import { runTriggerOnce } from "../commands/trigger";
import type { NormalizedEvent, ProviderPort } from "../harness/provider/types";
import { registerProject } from "../lib/project-registry";
import {
  buildGovernanceReport,
  readLatestGovernanceReport,
  renderGovernanceMarkdown,
  writeGovernanceArtifacts,
} from "./report";
import { summarizeReviewSpend } from "./spend";
import type { ManagedReviewManifest } from "../review/types";

// Flow 295 (F1): confirming a schedule creates the per-machine signing key in keryx's
// user-global directory. Point HOME and XDG_DATA_HOME at a throwaway directory so no
// test ever writes the developer's real key.
let keyHome = "";
const savedKeyEnv = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };
beforeEach(async () => {
  keyHome = await mkdtemp(path.join(tmpdir(), "keryx-schedule-key-home-"));
  process.env["HOME"] = keyHome;
  process.env["XDG_DATA_HOME"] = path.join(keyHome, ".local", "share");
});
afterEach(async () => {
  for (const [name, value] of Object.entries(savedKeyEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(keyHome, { recursive: true, force: true });
});


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

// Flow 295 (AC14): a scheduled `agent-task` run, driven end to end through
// `keryx trigger run`, lands in the same ledger, and its cost is in the report.
test("flow 295 AC14: a scheduled agent-task run's cost is included in project trigger spend", async () => {
  await addConfirmedSchedule(ROOT, {
    name: "check-github",
    on: { kind: "schedule", cron: "0 */4 * * *" },
    action: {
      kind: "agent-task",
      prompt: "Summarise open PRs.",
      dispatch: { provider: "scripted", model: "m", permissionMode: "ask", rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }, ceilingUsd: 1 },
      grants: { network: "off", tools: [], repos: [] },
    },
  });
  const provider: ProviderPort = {
    describe: () => ({ capabilities: {} as never, descriptor: { providerId: "scripted" } }),
    stream: (_request, opts) =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { sequence: 0, attemptId: opts.attemptId, kind: "usage_update", usage: { inputTokens: 1000, outputTokens: 200 } } as NormalizedEvent;
        yield { sequence: 1, attemptId: opts.attemptId, kind: "text_delta", text: "Nothing needs you." } as NormalizedEvent;
        yield { sequence: 2, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
      })(),
  };
  const log = console.log;
  console.log = () => {};
  try {
    await runTriggerOnce(ROOT, "check-github", {
      agentTask: {
        makeProvider: () => provider,
        planSandbox: () => ({ ok: true, launcher: "none", args: [], env: {}, wrap: () => ["/bin/true"] }),
      },
    });
  } finally {
    console.log = log;
  }
  const usd = (1000 * 3 + 200 * 15) / 1_000_000;
  const report = await buildGovernanceReport({ cwd: ROOT, filters: {}, allProjects: false, now: () => new Date() });
  // The reservation record carries no cost; the closing record carries the run's.
  expect(report.projects[0]?.triggerSpend).toEqual({
    state: "present",
    spentUsd: usd,
    runsWithCostRecorded: 1,
    runsWithCostNotRecorded: 1,
    runsTotal: 2,
  });
  expect(renderGovernanceMarkdown(report)).toContain("trigger spend (project-wide, never flow-attributed): $0.006 across 1 run(s) with recorded cost");
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
