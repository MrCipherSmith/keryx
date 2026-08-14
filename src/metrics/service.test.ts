import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { aggregateExecutionEvents, type ExecutionEvent } from "./events";
import { createExecutionRunRecord } from "./collector";
import {
  createPairedBenchmarkTemplate,
  createPairedBenchmarkTemplateV2,
  deriveRate,
  judgePanel,
  validatePairedBenchmark,
  validatePairedBenchmarkV2,
  wilsonInterval,
  type PairedBenchmarkManifestV2,
  type PairedBenchmarkRunV2,
} from "./benchmark";
import { compareExecutionRuns } from "./compare";
import { selectLightweightPlan } from "./lightweight";
import {
  readLatestPointer,
  writeRunArtifacts,
} from "./lifecycle";
import {
  renderRunMarkdown,
  stableJson,
  validateRunRecord,
  type ExecutionRunRecord,
} from "./record";

function record(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    run_id: "run-observability-test",
    schema_version: "0.1.0",
    run_mode: "orchestrator",
    skill: "flow-orchestrator",
    started_at: "2026-07-10T10:00:00.000Z",
    finished_at: "2026-07-10T10:00:10.000Z",
    parent_run_id: null,
    provenance: {
      commit: "abc123",
      branch: "feature/test",
      worktree: "/tmp/worktree",
      sources: [
        {
          name: "git",
          path: ".git",
          timestamp: "2026-07-10T10:00:00.000Z",
          reliability: "exact",
        },
      ],
    },
    metrics: {
      wall_time_seconds: {
        value: 10,
        reliability: "exact",
        source: "lifecycle",
      },
    },
    retries: [],
    final_status: "done",
    artifact_paths: [],
    ...overrides,
  };
}

test("validates provenance-bearing records and rejects missing provenance", () => {
  expect(validateRunRecord(record())).toEqual({ valid: true, errors: [] });

  const invalid = record({
    provenance: { commit: null, branch: null, worktree: null, sources: [] },
    metrics: {
      wall_time_seconds: {
        value: 10,
        reliability: "fabricated" as never,
        source: "test",
      },
    },
  });
  const result = validateRunRecord(invalid);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("reliability");
});

test("canonical JSON is stable and Markdown is rendered from the record", () => {
  const jsonA = stableJson({ z: 1, a: { y: true, x: 2 } });
  const jsonB = stableJson({ a: { x: 2, y: true }, z: 1 });
  expect(jsonA).toBe(jsonB);
  const markdown = renderRunMarkdown(record());
  expect(markdown).toContain("run-observability-test");
  expect(markdown).toContain("feature/test");
  expect(markdown).toContain("wall_time_seconds");
});

test("aggregates exact event counts and separates active from wall time", () => {
  const events: ExecutionEvent[] = [
    { event_id: "1", run_id: "run-a", type: "run_started", timestamp_utc: "2026-07-10T10:00:00.000Z", source: "runtime" },
    { event_id: "2", run_id: "run-a", type: "command_finished", timestamp_utc: "2026-07-10T10:00:02.000Z", source: "gdctx", details: { command_kind: "keryx" } },
    { event_id: "3", run_id: "run-a", type: "command_finished", timestamp_utc: "2026-07-10T10:00:03.000Z", source: "gdctx", details: { command_kind: "shell" } },
    { event_id: "4", run_id: "run-a", type: "file_read", timestamp_utc: "2026-07-10T10:00:04.000Z", source: "gdctx", details: { path: "src/a.ts" } },
    { event_id: "5", run_id: "run-a", type: "file_read", timestamp_utc: "2026-07-10T10:00:05.000Z", source: "gdctx", details: { path: "src/a.ts" } },
    { event_id: "6", run_id: "run-a", type: "run_paused", timestamp_utc: "2026-07-10T10:00:06.000Z", source: "runtime" },
    { event_id: "7", run_id: "run-a", type: "run_resumed", timestamp_utc: "2026-07-10T10:00:08.000Z", source: "runtime" },
    { event_id: "8", run_id: "run-a", type: "run_finished", timestamp_utc: "2026-07-10T10:00:10.000Z", source: "runtime" },
  ];
  const result = aggregateExecutionEvents(events, {
    startedAt: "2026-07-10T10:00:00.000Z",
    finishedAt: "2026-07-10T10:00:10.000Z",
  });
  expect(result.metrics.keryx_commands!.value).toBe(1);
  expect(result.metrics.shell_commands!.value).toBe(1);
  expect(result.metrics.context_files_read!.value).toBe(1);
  expect(result.metrics.wall_time_seconds!.value).toBe(10);
  expect(result.metrics.active_time_seconds!.value).toBe(8);
  expect(result.metrics.paused_time_seconds!.value).toBe(2);
  expect(result.retries).toHaveLength(0);
});

test("lightweight plan is bounded but keeps test and security gates", () => {
  const plan = selectLightweightPlan({
    changedFiles: ["src/metrics/record.ts"],
    reviewers: ["not-a-reviewer", "review-security-code"],
  });
  expect(plan.profile).toBe("lightweight");
  expect(plan.phases).toEqual(["gdgraph-affected", "focused-tests", "review"]);
  expect(plan.reviewer).toBe("review-security-code");
  expect(plan.requiredGates).toEqual(["tests", "security"]);
  expect(plan.skipped.some((item) => item.phase === "security")).toBe(false);
  expect(plan.skipped.length).toBeGreaterThan(0);
});

test("paired benchmark validation requires 3-5 tasks and never returns a speed claim", () => {
  const runs = ["a", "b", "c"].flatMap((taskId) => [
    { task_id: taskId, variant: "with-keryx" as const, run_id: `run-${taskId}-k`, quality: "pass", metrics: { active_time_seconds: null }, human_interventions: null },
    { task_id: taskId, variant: "without-keryx" as const, run_id: `run-${taskId}-d`, quality: "pass", metrics: { active_time_seconds: null }, human_interventions: null },
  ]);
  const result = validatePairedBenchmark(runs);
  expect(result.valid).toBe(true);
  expect(result.speed_claim).toBe("not-claimed");
});

test("benchmark template creates reproducible paired slots without fabricated metrics", () => {
  const template = createPairedBenchmarkTemplate(["task-a", "task-b", "task-c"]);
  expect(template.protocol).toBe("paired-3-5-v1");
  expect(template.runs).toHaveLength(6);
  expect(template.runs.every((run) => run.metrics.active_time_seconds === null)).toBe(true);
  expect(template.speed_claim).toBe("not-claimed");
});

test("run comparison preserves reliability and does not claim a speed winner", () => {
  const a = record({ run_id: "run-a", metrics: { active_time_seconds: { value: 4, reliability: "exact", source: "runtime" } } });
  const b = record({ run_id: "run-b", metrics: { active_time_seconds: { value: null, reliability: "unknown", source: "runtime" } } });
  const comparison = compareExecutionRuns(a, b);
  expect(comparison.metrics[0]?.a?.reliability).toBe("exact");
  expect(comparison.metrics[0]?.b?.reliability).toBe("unknown");
  expect(comparison.speed_claim).toBe("not-claimed");
});

test("subagents cannot create an independent root metrics report", () => {
  expect(() => createExecutionRunRecord({
    runId: "run-child-without-parent",
    runMode: "subagent",
    skill: "task-implementer",
    startedAt: "2026-07-10T10:00:00.000Z",
    finishedAt: "2026-07-10T10:00:01.000Z",
    provenance: record().provenance,
  })).toThrow();
});

// --- paired-3-5-v2 ---------------------------------------------------------

function v2StochasticRun(taskId: string, variant: PairedBenchmarkRunV2["variant"]): PairedBenchmarkRunV2 {
  return {
    task_id: taskId,
    variant,
    ladder: "metastore",
    model: "claude-frontier",
    cacheState: "cold",
    leakageAssertion: "passed",
    caseKind: "stochastic",
    tokenCap: 20000,
    seeds: [1, 2, 3],
    quality: "met",
    correctness: { value: 1, reliability: "exact", source: "grader" },
    distribution: {
      samples: [
        { seed: 1, value: 1200, reliability: "exact" },
        { seed: 2, value: 1350, reliability: "exact" },
        { seed: 3, value: 1180, reliability: "exact" },
      ],
      median: 1200,
      spread: 170,
      reliability: "exact",
    },
    human_interventions: null,
  };
}

function v2Manifest(): PairedBenchmarkManifestV2 {
  const runs = ["a", "b", "c"].flatMap((taskId) => [
    v2StochasticRun(taskId, "context-on"),
    v2StochasticRun(taskId, "context-off"),
  ]);
  return { protocol: "paired-3-5-v2", ladder: "metastore", task_ids: ["a", "b", "c"], runs };
}

test("v1 template runs still validate unchanged through the shared validator", () => {
  const template = createPairedBenchmarkTemplate(["task-a", "task-b", "task-c"]);
  // Fill run_ids the operator would supply, then validate via the (now v2-aware) entrypoint.
  const runs = template.runs.map((run, index) => ({ ...run, run_id: `run-${index}` }));
  const result = validatePairedBenchmark(runs);
  expect(result.valid).toBe(true);
  expect(result.protocol).toBe("paired-3-5-v1");
  expect(result.speed_claim).toBe("not-claimed");
});

test("v2 ablation manifest validates and never emits a speed claim", () => {
  const manifest = v2Manifest();
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(true);
  expect(result.protocol).toBe("paired-3-5-v2");
  expect(result.speed_claim).toBe("not-claimed");
  // Same manifest validates through the shared dispatcher too.
  expect(validatePairedBenchmark(manifest).valid).toBe(true);
});

test("v2 template produces paired ablation slots without fabricated metrics", () => {
  const manifest = createPairedBenchmarkTemplateV2(["task-a", "task-b", "task-c"]);
  expect(manifest.protocol).toBe("paired-3-5-v2");
  expect(manifest.runs).toHaveLength(6);
  expect(manifest.runs.every((run) => run.distribution === undefined && run.oracle === undefined)).toBe(true);
  expect(manifest.runs.every((run) => run.seeds.length === 3)).toBe(true);
  expect(validatePairedBenchmarkV2(manifest).valid).toBe(true);
});

test("v2 rejects a speed claim from mixed models", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.model = "local-ollama";
  manifest.speedClaim = { claimed: true, direction: "keryx-faster" };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("mixed models");
});

test("v2 rejects a speed claim resting on fewer than the required runs", () => {
  const manifest = v2Manifest();
  for (const run of manifest.runs) {
    run.seeds = [1, 2, 3]; // keep individual runs legal
  }
  // A claim whose stochastic evidence was collapsed to a single seed must be rejected.
  manifest.runs[0]!.seeds = [1];
  delete manifest.runs[0]!.distribution;
  manifest.speedClaim = { claimed: true, direction: "keryx-faster" };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("fewer than the required runs");
});

test("v2 rejects a numeric value without a reliability level", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.correctness = { value: 1 } as never;
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("without a reliability level");
});

test("v2 rejects an oracle metric field with no corresponding measurement", () => {
  const manifest = v2Manifest();
  // precision is present but was never actually measured (unknown / null).
  manifest.runs[0]!.oracle = { precision: { value: null, reliability: "unknown" } };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("without a corresponding measurement");
});

test("v2 rejects fewer than the required runs for a stochastic case", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.seeds = [1, 2];
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("needs >= 3 runs");
});

test("v2 keeps the honest-refusal invariant: refusal must score correctness 1", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.quality = "honest-refusal";
  manifest.runs[0]!.correctness = { value: 0, reliability: "exact", source: "grader" };
  const bad = validatePairedBenchmarkV2(manifest);
  expect(bad.valid).toBe(false);
  expect(bad.errors.join(" ")).toContain("honest refusal must score correctness: 1");

  manifest.runs[0]!.correctness = { value: 1, reliability: "exact", source: "grader" };
  expect(validatePairedBenchmarkV2(manifest).valid).toBe(true);
});

test("v2 oracle deterministic case validates as a single unpaired run", () => {
  const oracleRun = (taskId: string): PairedBenchmarkRunV2 => ({
    task_id: taskId,
    variant: "context-on",
    ladder: "metastore",
    model: "oracle",
    cacheState: "unknown",
    leakageAssertion: "not-applicable",
    caseKind: "deterministic",
    tokenCap: null,
    seeds: [1],
    quality: "met",
    oracle: {
      precision: { value: 0.9, reliability: "exact", source: "git-gold" },
      recall: { value: 0.8, reliability: "exact", source: "git-gold" },
      f1: { value: 0.85, reliability: "estimated", source: "formula" },
    },
    human_interventions: null,
  });
  const manifest: PairedBenchmarkManifestV2 = {
    protocol: "paired-3-5-v2",
    ladder: "metastore",
    task_ids: ["g1", "g2", "g3"],
    runs: [oracleRun("g1"), oracleRun("g2"), oracleRun("g3")],
  };
  expect(validatePairedBenchmarkV2(manifest).valid).toBe(true);
});

test("wilson 95% CI helper brackets the point rate and stays within [0,1]", () => {
  const ci = wilsonInterval(8, 10);
  expect(ci.rate).toBeCloseTo(0.8, 10);
  expect(ci.lower).toBeGreaterThan(0);
  expect(ci.upper).toBeLessThanOrEqual(1);
  expect(ci.lower).toBeLessThan(ci.rate);
  expect(ci.upper).toBeGreaterThan(ci.rate);
  // Degenerate n collapses to a zero interval rather than NaN.
  expect(wilsonInterval(0, 0)).toEqual({ rate: 0, lower: 0, upper: 0 });
});

test("judge panel helper derives strict and lenient consistently", () => {
  expect(judgePanel([2, 2, 2])).toMatchObject({ strict: true, lenient: true });
  expect(judgePanel([2, 2, 1])).toMatchObject({ strict: false, lenient: true });
  expect(judgePanel([2, 1, 0])).toMatchObject({ strict: false, lenient: false });
});

test("v2 accepts a well-formed rate (Wilson CI + n) and judge panel", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.rates = { detection: deriveRate(8, 10, "exact") };
  manifest.runs[0]!.judge = judgePanel([2, 2, 1], "two of three judges accepted");
  expect(validatePairedBenchmarkV2(manifest).valid).toBe(true);
});

test("v2 rejects a rate reported without an explicit n", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.rates = {
    detection: { successes: 8, rate: 0.8, ci95: { lower: 0.5, upper: 0.95 }, reliability: "exact" } as never,
  };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("without an explicit n");
});

test("v2 rejects a fabricated confidence interval that is not the Wilson interval", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.rates = {
    detection: { successes: 8, n: 10, rate: 0.8, ci95: { lower: 0.79, upper: 0.81 }, reliability: "exact" },
  };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("Wilson interval");
});

test("v2 rejects an inconsistent judge panel (strict flag disagrees with scores)", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.judge = { scores: [2, 2, 1], strict: true, lenient: true };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("strict flag inconsistent");
});

test("v2 rejects a cross-model token figure that is not tokenizer-normalized", () => {
  const manifest = v2Manifest();
  // Two distinct served models make this a cross-model comparison.
  manifest.runs[0]!.servedModel = "local-ollama";
  manifest.runs[1]!.servedModel = "claude-frontier";
  manifest.runs[0]!.cost = { tokens: { raw: { value: 1500, reliability: "exact", source: "provider" } } };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("not tokenizer-normalized");
});

test("v2 accepts a cross-model token figure once tokenizer-normalized", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.servedModel = "local-ollama";
  manifest.runs[1]!.servedModel = "claude-frontier";
  manifest.runs[0]!.cost = {
    tokens: {
      raw: { value: 1500, reliability: "exact", source: "provider" },
      normalized: { value: 1100, reliability: "estimated", source: "word-count" },
    },
  };
  expect(validatePairedBenchmarkV2(manifest).valid).toBe(true);
});

test("v2 rejects a speed claim resting on mixed served models", () => {
  const manifest = v2Manifest();
  manifest.runs[0]!.servedModel = "local-ollama"; // model requested is the same, served differs
  manifest.speedClaim = { claimed: true, direction: "keryx-faster" };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("mixed models");
});

test("v2 rejects a speed claim resting on mixed effort", () => {
  const manifest = v2Manifest();
  for (const run of manifest.runs) run.effort = "high";
  manifest.runs[0]!.effort = "low";
  manifest.speedClaim = { claimed: true, direction: "keryx-faster" };
  const result = validatePairedBenchmarkV2(manifest);
  expect(result.valid).toBe(false);
  expect(result.errors.join(" ")).toContain("mixed effort");
});

test("latest pointer is immutable-by-record and reports provenance mismatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-metrics-"));
  try {
    const first = await writeRunArtifacts(root, record());
    expect(first.pointer.record).toContain("runs/run-observability-test.json");
    const loaded = await readLatestPointer(root, {
      commit: "different",
      branch: "feature/test",
      worktree: "/tmp/worktree",
    });
    expect(loaded.status).toBe("mismatch");
    await expect(writeRunArtifacts(root, record())).rejects.toThrow("immutable");
    await writeFile(path.join(root, "latest.json"), JSON.stringify({ ...first.pointer, record: "../../outside.json" }));
    const traversal = await readLatestPointer(root);
    expect(traversal.status).toBe("stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
