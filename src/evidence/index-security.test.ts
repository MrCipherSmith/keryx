import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { createEvidenceLifecycle } from "./lifecycle";
import { publishValidatedEvidenceGeneration, searchValidatedEvidenceGeneration, type ValidatedSearchResult } from "./index";
import { evidenceChunkId } from "./search";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const document = { sourceId: "archive-1", sourcePath: "session-1", versionHash: "a".repeat(64), text: "private retrieval", scope: { kind: "session-archive" as const, id: "session-1" } };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "erl-index-security-")); roots.push(root);
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  return { store, lifecycle, scopeHash: "b".repeat(64), confirmSources: () => true, validateSources: async () => true,
    query: "retrieval", close() { lifecycle.close(); store.close(); } };
}
test("absent index handoff exceptions propagate once without corruption fallback", async () => {
  const f = await fixture(); let calls = 0; const error = new Error("transport failed");
  try {
    await expect(searchValidatedEvidenceGeneration(f, () => { calls++; throw error; })).rejects.toBe(error);
    expect(calls).toBe(1);
  } finally { f.close(); }
});
test("publication and search validators receive a deeply frozen canonical manifest", async () => {
  const f = await fixture(); let checks = 0;
  const validateSources = async (sources: readonly { versionHash: string; scope: { id: string } }[]) => {
    expect(Object.isFrozen(sources)).toBe(true); expect(Object.isFrozen(sources[0])).toBe(true);
    expect(Object.isFrozen(sources[0]!.scope)).toBe(true);
    try { sources[0]!.versionHash = "c".repeat(64); } catch { /* Frozen mutation must fail or leave the value unchanged. */ }
    expect(sources[0]!.versionHash).toBe(document.versionHash); checks++; return true;
  };
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources });
    const result = await searchValidatedEvidenceGeneration({ ...f, validateSources }, result => result);
    expect(result.code).toBe("ok"); expect(checks).toBe(2);
  } finally { f.close(); }
});
test("closing lifecycle during final confirmation withholds excerpts and publication", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document] });
    const result = await searchValidatedEvidenceGeneration({ ...f, confirmSources: () => { f.lifecycle.close(); return true; } }, result => result);
    expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]);
  } finally { f.close(); }
  const g = await fixture();
  try {
    await expect(publishValidatedEvidenceGeneration({ ...g, documents: [document], confirmSources: () => { g.lifecycle.close(); return true; } })).rejects.toThrow();
    expect(g.store.read("CURRENT", 4096)).toBeUndefined();
  } finally { g.close(); }
});
test("retention crossing during validation never hands off expired excerpts", async () => {
  const f = await fixture(); let now = Date.UTC(2026, 0, 1);
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], now: () => now });
    now += 30 * 86400000;
    const result = await searchValidatedEvidenceGeneration({ ...f, now: () => now, validateSources: async () => { now++; return true; } }, result => result);
    expect(result.items).toEqual([]); expect(result.reason).toBe("retention-expired");
  } finally { f.close(); }
});
test("blocking validator cannot win a timer race past its monotonic deadline", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document] });
    const result = await searchValidatedEvidenceGeneration({ ...f, timeoutMs: 1, validateSources: async () => {
      const end = performance.now() + 20; while (performance.now() < end) { /* Intentionally block past the deadline. */ } return true;
    } }, result => result);
    expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]);
  } finally { f.close(); }
});
test("native async transport is rejected before receiving even an absent-index result", async () => {
  const f = await fixture(); let invoked = false;
  try {
    // Cast intentionally bypasses the synchronous transport type to test runtime misuse.
    const handoff = (async () => { invoked = true; }) as unknown as (result: ValidatedSearchResult) => void;
    await expect(searchValidatedEvidenceGeneration(f, handoff)).rejects.toThrow("synchronous");
    expect(invoked).toBe(false);
  } finally { f.close(); }
});
test("checksum-consistent malformed chunk metadata never reaches transport", async () => {
  const f = await fixture();
  const mutations: ((chunk: Record<string, unknown>) => void)[] = [
    c => { c.endLine = 0; }, c => { c.startLine = "1"; }, c => { c.extra = true; },
    c => { c.contentHash = "c".repeat(64); }, c => { c.chunkId = "d".repeat(64); },
    c => { c.endByte = 1; }, c => { c.sourceId = 1; },
  ];
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document] });
    const pointer = JSON.parse(f.store.read("CURRENT", 4096)!.toString());
    const original = f.store.read(pointer.generation, 256 * 1024 * 1024)!;
    for (const mutate of mutations) {
      const generation = JSON.parse(original.toString()); mutate(generation.chunks[0]);
      const bytes = Buffer.from(JSON.stringify(generation));
      f.store.withWriter(() => {
        f.store.writeAtomic(pointer.generation, bytes);
        f.store.writeAtomic("CURRENT", Buffer.from(JSON.stringify({ ...pointer, sha256: createHash("sha256").update(bytes).digest("hex") })));
      });
      const result = await searchValidatedEvidenceGeneration(f, result => result);
      expect(result.code).toBe("index-corrupt"); expect(result.items).toEqual([]);
    }
  } finally { f.close(); }
});

test("checksum-consistent empty and oversized chunks are incompatible with the pinned producer", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document] });
    const pointer = JSON.parse(f.store.read("CURRENT", 4096)!.toString());
    const original = f.store.read(pointer.generation, 256 * 1024 * 1024)!;
    for (const size of [0, 401, 601, 16384]) {
      const generation = JSON.parse(original.toString()), c = generation.chunks[0];
      c.text = "x".repeat(size); c.endByte = c.startByte + size;
      c.contentHash = createHash("sha256").update(c.text).digest("hex"); c.chunkId = evidenceChunkId(c);
      const bytes = Buffer.from(JSON.stringify(generation));
      f.store.withWriter(() => {
        f.store.writeAtomic(pointer.generation, bytes);
        f.store.writeAtomic("CURRENT", Buffer.from(JSON.stringify({ ...pointer, sha256: createHash("sha256").update(bytes).digest("hex") })));
      });
      const result = await searchValidatedEvidenceGeneration(f, result => result);
      expect(result.code).toBe("index-corrupt"); expect(result.items).toEqual([]);
    }
  } finally { f.close(); }
});
test("tiny build budget refuses an oversized document without publication", async () => {
  const f = await fixture();
  try {
    await expect(publishValidatedEvidenceGeneration({ ...f, documents: [{ ...document, text: "x".repeat(1200) }], maxChunks: 1 })).rejects.toThrow("chunk budget");
    expect(f.store.read("CURRENT", 4096)).toBeUndefined();
  } finally { f.close(); }
});


test("source verification signal survives until publication and synchronous handoff", async () => {
  const f = await fixture(); let verification: AbortSignal | undefined;
  const validateSources = async (_sources: unknown, signal: AbortSignal) => { verification = signal; return true; };
  const confirmSources = () => verification !== undefined && !verification.aborted;
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources, confirmSources });
    expect(verification!.aborted).toBe(true);
    const result = await searchValidatedEvidenceGeneration({ ...f, validateSources, confirmSources }, result => {
      expect(verification!.aborted).toBe(false); return result;
    });
    expect(result.code).toBe("ok"); expect(verification!.aborted).toBe(true);
  } finally { f.close(); }
});
test("verification signal is disposed on rejection and transport exceptions", async () => {
  const f = await fixture(); let verification: AbortSignal | undefined;
  const validateSources = async (_sources: unknown, signal: AbortSignal) => { verification = signal; return true; };
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document] });
    const error = new Error("transport failed");
    await expect(searchValidatedEvidenceGeneration({ ...f, validateSources }, () => { throw error; })).rejects.toBe(error);
    expect(verification!.aborted).toBe(true);
    const result = await searchValidatedEvidenceGeneration({ ...f, validateSources: async (_sources, signal) => {
      verification = signal; throw new Error("scanner failure");
    } }, result => result);
    expect(result.code).toBe("source-unavailable"); expect(verification!.aborted).toBe(true);
  } finally { f.close(); }
});
