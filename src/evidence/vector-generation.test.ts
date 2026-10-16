import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { publishEvidenceGeneration, searchEvidenceGeneration } from "./index";
import { evidenceVectorKey, type EvidenceVectorIdentity } from "./hybrid";
import { createEvidenceVectorSnapshot, reusableEvidenceVectors } from "./vector-cache";

test("vectors publish atomically with chunks and reuse content across changed citation versions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl-vectors-")), store = openEvidenceStorage(root);
  const identity: EvidenceVectorIdentity = { project: store.projectRoot, adapter: "fixture", model: "model", revision: "1", dimensions: 2, sanitizer: "v1" };
  const doc = { sourceId: "source", sourcePath: "docs/a.txt", versionHash: "a".repeat(64), text: "apple orchard" };
  let reused = 0;
  const buildVectors: NonNullable<Parameters<typeof publishEvidenceGeneration>[0]["buildVectors"]> = async (chunks, previous) => {
    const hashes = [...new Set(chunks.map(chunk => chunk.contentHash))];
    const cached = reusableEvidenceVectors(previous, identity, hashes);
    reused += cached.length;
    expect(Object.isFrozen(chunks)).toBe(true);
    expect(Object.isFrozen(chunks[0])).toBe(true);
    return createEvidenceVectorSnapshot(identity, hashes.map(contentHash => cached.find(record => record.contentHash === contentHash) ??
      { contentHash, key: evidenceVectorKey(identity, contentHash), values: [1, 0] }));
  };
  try {
    const first = await publishEvidenceGeneration({ store, documents: [doc], buildVectors, validateSources: async () => true });
    const second = await publishEvidenceGeneration({ store, documents: [{ ...doc, versionHash: "b".repeat(64) }], buildVectors, validateSources: async () => true });
    expect(reused).toBe(1);
    expect(second.generation).not.toBe(first.generation);
    expect(searchEvidenceGeneration(store, "apple").items[0]!.versionHash).toBe("b".repeat(64));
    const before = store.read("CURRENT", 4096);
    await expect(publishEvidenceGeneration({ store, documents: [doc], buildVectors: async () =>
      createEvidenceVectorSnapshot({ ...identity, project: "foreign" }, []), validateSources: async () => true })).rejects.toThrow();
    expect(store.read("CURRENT", 4096)).toEqual(before);
    await expect(publishEvidenceGeneration({ store, documents: [doc], buildVectors: async () =>
      createEvidenceVectorSnapshot(identity, []), validateSources: async () => true })).rejects.toThrow();
    expect(store.read("CURRENT", 4096)).toEqual(before);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("vector callback failure leaves old CURRENT intact without separate cache artifacts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "erl-vectors-")), store = openEvidenceStorage(root);
  const doc = { sourceId: "s", sourcePath: "docs/a.txt", versionHash: "a".repeat(64), text: "apple" };
  try {
    await publishEvidenceGeneration({ store, documents: [doc], validateSources: async () => true });
    const before = store.read("CURRENT", 4096);
    await expect(publishEvidenceGeneration({ store, documents: [doc], validateSources: async () => true,
      buildVectors: async () => { throw Error("unavailable"); } })).rejects.toThrow();
    expect(store.read("CURRENT", 4096)).toEqual(before);
    expect(readdirSync(path.join(root, ".metaproject/evidence")).some(name => name.includes("vector"))).toBe(false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
