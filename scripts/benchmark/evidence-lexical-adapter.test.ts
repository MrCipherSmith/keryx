import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { prepareEvidenceEvaluation } from "./prepare-evidence-evaluation";
import { createLexicalEvaluationAdapter } from "./evidence-lexical-adapter";
import { runEvidenceEvaluation } from "./run-evidence-evaluation";

const fixture = new URL("../../docs/requirements/keryx-evidence-retrieval/paired-evaluation-starter.json", import.meta.url);

test("reduced benign corpus: real scanner and lexical runtime produce byte spans", async () => {
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.sources = data.sources.filter((source: { id: string }) => source.id !== "held-6");
  data.queries = data.queries.filter((query: { id: string }) => ["dev-q1", "q1", "q5", "q6", "q8"].includes(query.id));
  // Exercise byte rather than UTF-16 offsets without modifying the retrieval label.
  data.sources.find((source: { id: string }) => source.id === "held-1").text += " Unicode: café 🪴.";
  const raw = JSON.stringify(data), prepared = prepareEvidenceEvaluation(raw);
  const owner = await createLexicalEvaluationAdapter(raw);
  const query = prepared.queries.find(query => query.id === "q1")!;
  const request = { datasetHash: prepared.datasetHash, queryId: query.id, queryHash: query.queryHash,
    repetition: 0, signal: new AbortController().signal };
  try {
    expect(owner.preparation.projectCount).toBe(2);
    const result = await owner.adapter.run(request);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw Error("runtime failed");
    expect(result.ranking.length).toBeGreaterThan(0);
    expect(result.ranking.every(span => ["held-1", "held-2", "held-5"].includes(span.source))).toBe(true);
    const match = result.ranking.find(span => span.source === "held-1")!;
    const source = data.sources.find((source: { id: string }) => source.id === "held-1");
    expect(match.endByte).toBe(Buffer.byteLength(source.text));
    expect(match.sourceHash).toBe(query.relevant[0]!.sourceHash);
    expect(await owner.adapter.run({ ...request, datasetHash: "wrong" })).toEqual({ status: "failed" });
    expect(await owner.adapter.run({ ...request, queryHash: "wrong" })).toEqual({ status: "failed" });
    const controller = new AbortController(); controller.abort();
    expect(await owner.adapter.run({ ...request, signal: controller.signal })).toEqual({ status: "failed" });
    const report = await runEvidenceEvaluation(raw, { B: owner.adapter });
    expect(report.observations.filter(row => row.arm === "B" && ["q1", "dev-q1"].includes(row.queryId))
      .every(row => row.status === "ok" && row.score.recallAt10 === 1)).toBe(true);
    expect(report.observations.filter(row => row.arm === "B" && ["q5", "q6", "q8"].includes(row.queryId))
      .every(row => row.status === "unsupported" && row.elapsedMs === null)).toBe(true);
    expect(report.observations.filter(row => ["A", "C", "D", "E"].includes(row.arm))
      .every(row => row.status === "missing-adapter")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("café");
  } finally { await owner.close(); }
  expect(await owner.adapter.run(request)).toEqual({ status: "failed" });
  await owner.close();
}, 120000);

test("invalid corpus is rejected before runtime setup", async () => {
  await expect(createLexicalEvaluationAdapter("{}")).rejects.toThrow("unsupported dataset");
});


test("cleanup drains an active cancelled search and refuses concurrent work", async () => {
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.queries = data.queries.filter((query: { id: string }) => query.id === "dev-q1");
  const raw = JSON.stringify(data), prepared = prepareEvidenceEvaluation(raw);
  const owner = await createLexicalEvaluationAdapter(raw);
  const query = prepared.queries[0]!;
  const controller = new AbortController();
  const request = { datasetHash: prepared.datasetHash, queryId: query.id, queryHash: query.queryHash,
    repetition: 0, signal: controller.signal };
  const operation = owner.adapter.run(request);
  try {
    expect(await owner.adapter.run(request)).toEqual({ status: "failed" });
    controller.abort();
    await Promise.all([operation, owner.close(), owner.close()]);
    expect(await owner.adapter.run(request)).toEqual({ status: "failed" });
  } finally { await owner.close(); }
}, 120000);

test("scanner-modified source never receives original-envelope recall credit", async () => {
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.queries = data.queries.filter((query: { id: string }) => query.id === "dev-q1");
  const source = data.sources.find((source: { id: string }) => source.id === "dev-1");
  source.text += " Credential: " + ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const raw = JSON.stringify(data), prepared = prepareEvidenceEvaluation(raw);
  const owner = await createLexicalEvaluationAdapter(raw);
  try {
    const query = prepared.queries[0]!;
    const result = await owner.adapter.run({ datasetHash: prepared.datasetHash, queryId: query.id,
      queryHash: query.queryHash, repetition: 0, signal: new AbortController().signal });
    expect(result.status === "failed" || (result.status === "ok" && result.ranking.length === 0)).toBe(true);
  } finally { await owner.close(); }
}, 120000);
