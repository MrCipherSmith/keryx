import { expect, test } from "bun:test";
import { chunkEvidence } from "./search";
import { evidenceVectorKey, rankEvidenceHybrid, type EvidenceVectorIdentity } from "./hybrid";

const identity: EvidenceVectorIdentity = {
  project: "project-a", adapter: "offline-fixture", model: "fixture-model",
  revision: "1", dimensions: 2, sanitizer: "fixture-sanitizer-v1",
};
const chunks = ["apple orchard", "motor vehicle", "apple fruit"].map((text, i) =>
  chunkEvidence({ sourceId: `source-${i}`, sourcePath: `docs/${i}.txt`, versionHash: "a".repeat(64), text })[0]!);
const semantic = () => ({ identity, expectedIdentity: identity, query: [1, 0], vectors: chunks.map((chunk, i) => ({
  key: evidenceVectorKey(identity, chunk.contentHash), values: i === 1 ? [1, 0] : [0, 1],
})) });

test("independent cosine pool recalls a chunk with zero lexical overlap", () => {
  const result = rankEvidenceHybrid(chunks, "apple", semantic(), 3);
  expect(result.diagnostics).toEqual([]);
  expect(result.items.map(item => item.chunk.sourceId)).toContain("source-1");
  expect(result.items.every(item => Number.isFinite(item.score) && item.score > 0)).toBe(true);
});

test("absent semantic capability preserves exact BM25 order and scores", () => {
  const result = rankEvidenceHybrid(chunks, "apple", null, 3);
  expect(result.diagnostics).toEqual(["semantic-fallback"]);
  expect(result.items.map(item => item.chunk.sourceId)).toEqual(["source-0", "source-2"]);
  expect(result.items[0]!.score).toBeGreaterThan(1 / 61);
});

test("RRF includes both ranks, deduplicates the union and deterministically resolves ties", () => {
  const result = rankEvidenceHybrid(chunks, "apple", semantic(), 3);
  expect(new Set(result.items.map(item => item.chunk.chunkId)).size).toBe(result.items.length);
  expect(result.items[0]!.chunk.sourceId).toBe("source-0");
  expect(result.items[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
  expect(rankEvidenceHybrid(chunks, "apple", semantic(), 3)).toEqual(result);
});

test("vector keys bind full hash, project, sanitizer and complete model identity", () => {
  const key = evidenceVectorKey(identity, chunks[0]!.contentHash);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  for (const field of ["project", "adapter", "model", "revision", "sanitizer"] as const)
    expect(evidenceVectorKey({ ...identity, [field]: `${identity[field]}-changed` }, chunks[0]!.contentHash)).not.toBe(key);
  expect(evidenceVectorKey({ ...identity, dimensions: 3 }, chunks[0]!.contentHash)).not.toBe(key);
  expect(() => evidenceVectorKey(identity, "a".repeat(16))).toThrow();
});

test("bad dimensions, nonfinite, zero or stale vectors fail to lexical with no semantic hits", () => {
  for (const values of [[1], [Infinity, 0], [NaN, 0], [0, 0]]) {
    const data = semantic(); data.vectors[0]!.values = values;
    expect(rankEvidenceHybrid(chunks, "apple", data, 3)).toEqual(rankEvidenceHybrid(chunks, "apple", null, 3));
  }
  const data = semantic(); data.vectors[0]!.key = "b".repeat(64);
  expect(rankEvidenceHybrid(chunks, "apple", data, 3).diagnostics).toEqual(["semantic-fallback"]);
});

test("missing vector, duplicate vector or malformed query refuse semantic pool", () => {
  const missing = semantic(); missing.vectors.pop();
  const duplicate = semantic(); duplicate.vectors.push(duplicate.vectors[0]!);
  const query = semantic(); query.query = [1];
  for (const data of [missing, duplicate, query])
    expect(rankEvidenceHybrid(chunks, "apple", data, 3).diagnostics).toEqual(["semantic-fallback"]);
});


test("independently changed approved identity never accepts the old cache", () => {
  for (const field of ["project", "adapter", "model", "revision", "sanitizer"] as const) {
    const data = semantic(); data.expectedIdentity = { ...identity, [field]: `${identity[field]}-changed` };
    expect(rankEvidenceHybrid(chunks, "apple", data).diagnostics).toEqual(["semantic-fallback"]);
  }
  const data = semantic(); data.expectedIdentity = { ...identity, dimensions: 3 };
  expect(rankEvidenceHybrid(chunks, "apple", data).diagnostics).toEqual(["semantic-fallback"]);
});

test("large finite vectors normalize without overflow and shuffled input preserves ranking", () => {
  const data = semantic(); data.query = [Number.MAX_VALUE, 0];
  data.vectors[1]!.values = [Number.MAX_VALUE, 0];
  const result = rankEvidenceHybrid(chunks, "apple", data, 3);
  expect(result.diagnostics).toEqual([]);
  expect(rankEvidenceHybrid([...chunks].reverse(), "apple", data, 3)).toEqual(result);
});

test("same sanitized content shares one vector without merging distinct citations", () => {
  const copy = { ...chunks[0]!, sourceId: "renamed-source", sourcePath: "docs/renamed.txt", chunkId: "b".repeat(64) };
  const data = { identity, expectedIdentity: identity, query: [1, 0], vectors: [{
    key: evidenceVectorKey(identity, copy.contentHash), values: [1, 0],
  }] };
  const result = rankEvidenceHybrid([chunks[0]!, copy], "apple", data, 2);
  expect(result.diagnostics).toEqual([]);
  expect(result.items).toHaveLength(2);
  expect(new Set(result.items.map(item => item.chunk.sourceId)).size).toBe(2);
});

test("each candidate pool truncates independently at 100 before RRF", () => {
  const corpus = Array.from({ length: 101 }, (_, i) => chunkEvidence({
    sourceId: `source-${String(i).padStart(3, "0")}`, sourcePath: `docs/${i}.txt`,
    versionHash: "a".repeat(64), text: `apple item ${i}`,
  })[0]!);
  const data = { identity, expectedIdentity: identity, query: [1, 0], vectors: corpus.map((chunk, i) => ({
    key: evidenceVectorKey(identity, chunk.contentHash), values: i === 100 ? [1, 0] : [0, 1],
  })) };
  const result = rankEvidenceHybrid(corpus, "apple", data, 100);
  expect(result.items).toHaveLength(100);
  expect(result.items.find(item => item.chunk.sourceId === "source-100")!.score).toBeCloseTo(1 / 61, 12);
});
