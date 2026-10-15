import { expect, test } from "bun:test";
import { prepareEvidenceEvaluation } from "./prepare-evidence-evaluation";
function fixture() {
  return { version: 1, status: "exploratory-smoke-only", synthetic: true,
    sources: [{ id: "s", project: "p", session: "s", split: "held-out", version: 1,
      state: "active", text: "猫 retry four times" }],
    queries: [{ id: "q", project: "p", session: "s", split: "held-out", class: "answerable",
      text: "Retry limit?", relevant: [{ source: "s", quote: "retry four times" }] }] };
}
test("deterministic byte-exact manifest makes no measured claims", () => {
  const raw = JSON.stringify(fixture()), report = prepareEvidenceEvaluation(raw);
  expect(report).toEqual(prepareEvidenceEvaluation(raw));
  expect(report.queries[0]!.relevant[0]).toMatchObject({ startByte: 4, endByte: 20 });
  expect(report.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  expect(report.metrics).toBeNull(); expect(report.rolloutDecision).toBeNull();
  expect(report.arms.every(arm => arm.status === "not-run")).toBe(true);
});
test("rejects duplicate ids and ambiguous quotes", () => {
  const data = fixture(); data.sources.push({ ...data.sources[0]! });
  expect(() => prepareEvidenceEvaluation(JSON.stringify(data))).toThrow();
  const ambiguous = fixture(); ambiguous.sources[0]!.text += " retry four times";
  expect(() => prepareEvidenceEvaluation(JSON.stringify(ambiguous))).toThrow();
});
test("rejects project and session split leakage", () => {
  for (const field of ["project", "session"] as const) {
    const data = fixture();
    data.sources.push({ ...data.sources[0]!, id: "other", project: "other", session: "other", split: "dev",
      [field]: data.sources[0]![field] });
    expect(() => prepareEvidenceEvaluation(JSON.stringify(data))).toThrow();
  }
});
test("rejects stale and cross-project labels", () => {
  for (const patch of [{ state: "revoked" }, { state: "superseded" }, { project: "elsewhere" }]) {
    const data = fixture(); Object.assign(data.sources[0]!, patch);
    expect(() => prepareEvidenceEvaluation(JSON.stringify(data))).toThrow();
  }
});
test("rejects unsupported scenarios and malformed datasets", () => {
  const data = fixture(); data.queries[0]!.class = "future-scenario";
  expect(() => prepareEvidenceEvaluation(JSON.stringify(data))).toThrow();
  expect(() => prepareEvidenceEvaluation("{")).toThrow();
  const real = fixture(); real.synthetic = false;
  expect(() => prepareEvidenceEvaluation(JSON.stringify(real))).toThrow();
});
test("rejects lifecycle scenarios without prerequisites", () => {
  const data = fixture(); data.queries[0]!.class = "rewritten-cross-project";
  expect(() => prepareEvidenceEvaluation(JSON.stringify(data))).toThrow();
  data.queries[0]!.class = "revoked"; data.queries[0]!.relevant = [];
  expect(() => prepareEvidenceEvaluation(JSON.stringify(data))).toThrow();
  expect(prepareEvidenceEvaluation(JSON.stringify(fixture())).missingCoverage).toEqual(["deleted-source"]);
});
test("starter remains preparation rather than quality evidence", async () => {
  const raw = await Bun.file(new URL("../../docs/requirements/keryx-evidence-retrieval/paired-evaluation-starter.json", import.meta.url)).text();
  const report = prepareEvidenceEvaluation(raw);
  expect(report.sources).toHaveLength(8); expect(report.queries).toHaveLength(10);
  expect(report.queries.every(query => query.scenarioStatus === "not-run")).toBe(true);
  expect(report.queries.find(query => query.id === "q5")!.visibility).toMatchObject({ proofStatus: "not-run" });
});
