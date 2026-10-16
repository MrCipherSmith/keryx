import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { publishEvidenceGeneration, searchEvidenceGeneration } from "./index";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "erl-index-")); roots.push(root); return root; }
const doc = (text: string, sourceId = "file-1") => ({ sourceId, sourcePath: "src/a.ts", versionHash: "a".repeat(64), text });
test("full build publishes immutable checksummed generation and atomically points CURRENT", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    const result = await publishEvidenceGeneration({ store, documents: [doc("retrieval evidence")], validateSources: async () => true });
    expect(result.chunkCount).toBe(1);
    expect(searchEvidenceGeneration(store, "retrieval").code).toBe("ok");
    expect(searchEvidenceGeneration(store, "retrieval").items[0]?.text).toBe("retrieval evidence");
  } finally { store.close(); }
});
test("source validation failure and publication fault preserve prior CURRENT", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    const first = await publishEvidenceGeneration({ store, documents: [doc("old corpus")], validateSources: async () => true });
    await expect(publishEvidenceGeneration({ store, documents: [doc("new corpus")], validateSources: async () => false })).rejects.toThrow("source changed");
    const before = store.read("CURRENT", 4096)?.toString();
    store.withWriter(() => expect(() => store.writeAtomic("CURRENT", Buffer.from("broken"), () => { throw new Error("simulated crash"); })).toThrow());
    expect(store.read("CURRENT", 4096)?.toString()).toBe(before);
    expect(searchEvidenceGeneration(store, "old").generation).toBe(first.generation);
  } finally { store.close(); }
});
test("corrupt pointers or generation bytes return no partial results", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    await publishEvidenceGeneration({ store, documents: [doc("private retrieval")], validateSources: async () => true });
    store.withWriter(() => store.writeAtomic("CURRENT", Buffer.from("{}")));
    expect(searchEvidenceGeneration(store, "retrieval")).toEqual({ code: "index-corrupt", items: [] });
  } finally { store.close(); }
});
test("rejects failed full-build source validation without creating CURRENT", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    await expect(publishEvidenceGeneration({ store, documents: [doc("stale")], validateSources: async () => false })).rejects.toThrow();
    expect(store.read("CURRENT", 4096)).toBeUndefined();
  } finally { store.close(); }
});
test("configured index byte cap refuses publication and preserves CURRENT", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    await publishEvidenceGeneration({ store, documents: [doc("old corpus")], validateSources: async () => true });
    const before = store.read("CURRENT", 4096)?.toString();
    const options = { store, documents: [doc("new corpus")], maxIndexBytes: 64, validateSources: async () => true };
    await expect(publishEvidenceGeneration(options)).rejects.toThrow("byte budget");
    expect(store.read("CURRENT", 4096)?.toString()).toBe(before);
    for (const maxIndexBytes of [0, NaN, 1.5, 256 * 1024 * 1024 + 1]) {
      await expect(publishEvidenceGeneration({ ...options, maxIndexBytes })).rejects.toThrow("byte budget");
    }
  } finally { store.close(); }
});

test("checkpoint after generation persistence preserves CURRENT on exhausted budget", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    await publishEvidenceGeneration({ store, documents: [doc("old")], validateSources: async () => true });
    const before = store.read("CURRENT", 4096)?.toString();
    let checks = 0;
    await expect(publishEvidenceGeneration({ store, documents: [doc("new")], validateSources: async () => true,
      beforePublish: () => { if (++checks === 2) throw Error("deadline exhausted after persistence"); },
    })).rejects.toThrow("deadline exhausted");
    expect(checks).toBe(2);
    expect(store.read("CURRENT", 4096)?.toString()).toBe(before);
  } finally { store.close(); }
});
