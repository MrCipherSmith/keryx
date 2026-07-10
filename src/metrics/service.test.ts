import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { aggregateExecutionEvents, type ExecutionEvent } from "./events";
import { createExecutionRunRecord } from "./collector";
import { createPairedBenchmarkTemplate, validatePairedBenchmark } from "./benchmark";
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
