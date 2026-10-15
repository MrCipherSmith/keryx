import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { prepareEvidenceEvaluation } from "./prepare-evidence-evaluation";
import { runEvidenceEvaluation } from "./run-evidence-evaluation";
import type { EvaluationAdapter } from "./run-evidence-evaluation";
const fixture = new URL("../../docs/requirements/keryx-evidence-retrieval/paired-evaluation-starter.json", import.meta.url);
const raw = () => readFile(fixture, "utf8");
test("no adapters means missing rather than simulated success", async () => {
  const report = await runEvidenceEvaluation(await raw(), {});
  expect(report.observations.length).toBe(150);
  expect(report.observations.every(row => row.status === "missing-adapter" && row.elapsedMs === null &&
    row.score.recallAt10 === null)).toBe(true);
  expect(report.comparisons.every(row => row.pairs === 0 && row.delta === null)).toBe(true);
  expect(report.rolloutDecision).toBeNull();
});
test("timing repetitions stay one pair and dev/held-out remain separate", async () => {
  const input = await raw(), prepared = prepareEvidenceEvaluation(input);
  const adapter: EvaluationAdapter = { revision: "test-fixture-only", scenarios: ["answerable", "paraphrased"],
    run: async request => {
      expect(request.datasetHash).toBe(prepared.datasetHash);
      const query = prepared.queries.find(query => query.id === request.queryId)!;
      return { status: "ok", ranking: query.relevant.map(label => ({ ...label, version: Number(label.version) })) };
    } };
  const report = await runEvidenceEvaluation(input, { B: adapter, C: adapter });
  const supported = prepared.queries.filter(query => adapter.scenarios.includes(query.kind));
  expect(report.observations.filter(row => row.status === "ok").length).toBe(supported.length * 6);
  for (const split of ["dev", "held-out"]) {
    const score = report.comparisons.find(row => row.split === split && row.candidate === "C" && row.metric === "recallAt10")!;
    expect(score.pairs).toBe(supported.filter(query => query.split === split).length);
    expect(score.delta).toBe(0);
  }
});
test("lifecycle and visibility cannot masquerade as static retrieval", async () => {
  const input = await raw(), prepared = prepareEvidenceEvaluation(input), called: string[] = [];
  const adapter: EvaluationAdapter = { revision: "fixture", scenarios: prepared.queries.map(query => query.kind),
    run: async request => { called.push(request.queryId); return { status: "ok", ranking: [] }; } };
  const report = await runEvidenceEvaluation(input, { D: adapter });
  for (const query of prepared.queries.filter(query => ["current-visible", "compacted-out", "rewritten-cross-project", "revoked"].includes(query.kind))) {
    expect(called).not.toContain(query.id);
    expect(report.observations.filter(row => row.arm === "D" && row.queryId === query.id)
      .every(row => row.status === "unsupported" && row.score.recallAt10 === null)).toBe(true);
  }
});
test("exceptions and ineligible ranking do not leak text or become zero", async () => {
  const report = await runEvidenceEvaluation(await raw(), {
    B: { revision: "fixture", scenarios: ["answerable"], run: async () => { throw Error("PRIVATE_SECRET"); } },
    C: { revision: "fixture", scenarios: ["answerable"], run: async () => ({ status: "ok", ranking: [
      { source: "unknown", version: 1, sourceHash: "a".repeat(64), startByte: 0, endByte: 1 },
    ] }) },
  });
  expect(report.observations.some(row => row.status === "failed")).toBe(true);
  expect(report.observations.some(row => row.status === "invalid-observation")).toBe(true);
  const rejected = report.observations.filter(row => row.arm === "C" && row.status !== "unsupported");
  expect(rejected.length).toBeGreaterThan(0);
  expect(rejected.every(row => row.status === "invalid-observation" && row.score.recallAt10 === null)).toBe(true);
  expect(JSON.stringify(report)).not.toContain("PRIVATE_SECRET");
  const attempted = report.observations.filter(row => ["failed", "invalid-observation"].includes(row.status));
  expect(attempted.length).toBeGreaterThan(0);
  expect(attempted.every(row => row.elapsedMs !== null && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)).toBe(true);
  expect(report.observations.filter(row => ["missing-adapter", "unsupported"].includes(row.status))
    .every(row => row.elapsedMs === null)).toBe(true);
  for (const arm of report.arms) {
    expect(arm.attempted).toBe(attempted.filter(row => row.arm === arm.arm).length);
    expect(arm.latencyPopulation).toBe("successful-observations-only");
    expect(arm.latency.samples).toBe(0);
    expect(arm.latency.p50Ms).toBeNull();
    expect(arm.latency.p95Ms).toBeNull();
  }
});
test("invalid dataset refuses before invoking adapters", async () => {
  let calls = 0;
  const adapter: EvaluationAdapter = { revision: "fixture", scenarios: ["answerable"],
    run: async () => { calls++; return { status: "ok", ranking: [] }; } };
  await expect(runEvidenceEvaluation("{}", { B: adapter })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("deadline aborts and stops further invocations even if adapter ignores signal", async () => {
  let calls = 0, signal: AbortSignal | undefined;
  const adapter: EvaluationAdapter = { revision: "fixture", scenarios: ["answerable"],
    run: request => { calls++; signal = request.signal; return new Promise(() => {}); } };
  const report = await runEvidenceEvaluation(await raw(), { B: adapter, C: adapter }, 1);
  expect(calls).toBe(1);
  expect(signal?.aborted).toBe(true);
  expect(report.observations.filter(row => row.status === "timed-out").length).toBe(1);
  expect(report.observations.some(row => row.status === "cancelled")).toBe(true);
  expect(report.comparisons.every(row => row.pairs === 0)).toBe(true);
});
test("distractor queries refuse while distractor sources stay permitted", async () => {
  const input = await raw();
  expect(prepareEvidenceEvaluation(input).queries.length).toBe(10);
  const data = JSON.parse(input);
  data.queries.push({ id: "bad", class: "unanswerable", split: "distractor",
    project: "other-garden", session: "other-ops", text: "question", relevant: [] });
  await expect(runEvidenceEvaluation(JSON.stringify(data), {})).rejects.toThrow("invalid query split");
});
