import { expect, test } from "bun:test";
import { evidenceVectorKey, type EvidenceVectorIdentity } from "./hybrid";
import { createEvidenceVectorSnapshot, readEvidenceVectorSnapshot, reusableEvidenceVectors } from "./vector-cache";
const identity: EvidenceVectorIdentity = { project: "project", adapter: "fixture", model: "model", revision: "1", dimensions: 2, sanitizer: "v1" };
const record = (hash = "a".repeat(64)) => ({ contentHash: hash, key: evidenceVectorKey(identity, hash), values: [1, 0] });
test("snapshot clones and deep freezes identity, records and vector arrays", () => {
  const input = record(), model = { ...identity };
  const snapshot = createEvidenceVectorSnapshot(model, [input]);
  input.values[0] = 9; model.model = "other";
  expect(snapshot.records[0]!.values).toEqual([1, 0]);
  expect(snapshot.identity.model).toBe("model");
  for (const object of [snapshot, snapshot.identity, snapshot.records, snapshot.records[0], snapshot.records[0]!.values])
    expect(Object.isFrozen(object)).toBe(true);
  expect(readEvidenceVectorSnapshot(JSON.parse(JSON.stringify(snapshot)), identity)).toEqual(snapshot);
});
test("canonical snapshots and checksums do not depend on insertion order", () => {
  const a = record(), b = record("b".repeat(64));
  expect(createEvidenceVectorSnapshot(identity, [a, b])).toEqual(createEvidenceVectorSnapshot(identity, [b, a]));
});
test("reuse deduplicates content and drops changed content or incompatible identity", () => {
  const snapshot = createEvidenceVectorSnapshot(identity, [record()]);
  expect(reusableEvidenceVectors(snapshot, identity, [record().contentHash, record().contentHash])).toHaveLength(1);
  expect(reusableEvidenceVectors(snapshot, identity, ["b".repeat(64)])).toEqual([]);
  for (const field of ["project", "adapter", "model", "revision", "sanitizer"] as const) {
    const changed = { ...identity, [field]: "changed" };
    expect(() => readEvidenceVectorSnapshot(snapshot, changed)).toThrow();
    expect(reusableEvidenceVectors(snapshot, changed, [record().contentHash])).toEqual([]);
  }
  expect(reusableEvidenceVectors(snapshot, { ...identity, dimensions: 3 }, [record().contentHash])).toEqual([]);
});
test("corrupt checksum, unknown fields, duplicate keys and malformed vectors fail closed", () => {
  const snapshot = createEvidenceVectorSnapshot(identity, [record()]);
  expect(() => readEvidenceVectorSnapshot({ ...snapshot, sha256: "b".repeat(64) }, identity)).toThrow();
  expect(() => readEvidenceVectorSnapshot({ ...snapshot, extra: true }, identity)).toThrow();
  expect(() => createEvidenceVectorSnapshot(identity, [record(), record()])).toThrow();
  for (const values of [[0, 0], [Infinity, 0], [NaN, 0], [1], ["1", 0]])
    expect(() => createEvidenceVectorSnapshot(identity, [{ ...record(), values: values as number[] }])).toThrow();
  expect(() => createEvidenceVectorSnapshot(identity, [{ ...record(), key: "b".repeat(64) }])).toThrow();
});
test("finite byte caps include serialized envelope, not just raw floats", () => {
  expect(() => createEvidenceVectorSnapshot(identity, [record()], 16)).toThrow();
  for (const cap of [0, -1, NaN, Infinity, 256 * 1024 * 1024 + 1])
    expect(() => createEvidenceVectorSnapshot(identity, [], cap)).toThrow();
});
