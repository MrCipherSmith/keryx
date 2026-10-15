import { canAppendArchive, createArchiveCheckpoint } from "./archive-checkpoint";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { createEvidenceLifecycle } from "./lifecycle";
import { publishValidatedEvidenceGeneration, searchValidatedEvidenceGeneration } from "./index";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = { kind: "session-archive" as const, id: "session-1" };
const document = { sourceId: "archive-1", sourcePath: "session-1", versionHash: "a".repeat(64), text: "private retrieval", scope };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "erl-index-ledger-")); roots.push(root);
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  return { store, lifecycle, scopeHash: "b".repeat(64), confirmSources: () => true, close() { lifecycle.close(); store.close(); } };
}
test("validated search checks sources and hands off synchronously under a reader lease", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources: async () => true });
    let checks = 0;
    const result = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", validateSources: async () => { checks++; return true; } }, result => result);
    expect(checks).toBe(1); expect(result.code).toBe("ok"); expect(result.items[0]?.text).toBe(document.text);
    const release = f.store.pinReaders(true); expect(release).toBeDefined(); release?.();
  } finally { f.close(); }
});
test("revocation during build refuses publication and releases its pin", async () => {
  const f = await fixture(); let drain: Promise<void> | undefined;
  try {
    await expect(publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources: async () => {
      drain = f.lifecycle.revokeAndDrain(scope); return true;
    } })).rejects.toThrow();
    await drain; expect(f.store.read("CURRENT", 4096)).toBeUndefined();
  } finally { f.close(); }
});
test("revocation during search cannot hand off old indexed excerpts", async () => {
  const f = await fixture(); let drain: Promise<void> | undefined;
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources: async () => true });
    const result = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", validateSources: async () => {
      drain = f.lifecycle.revokeAndDrain(scope); return true;
    } }, result => result);
    await drain; expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]);
  } finally { f.close(); }
});
test("missing initialized ledger never serves cached text", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources: async () => true });
    f.store.withWriter(() => f.store.remove("ledger.json"));
    const result = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", validateSources: async () => true }, result => result);
    expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]);
  } finally { f.close(); }
});
test("expired generations require explicit reindex without refreshing eligibility on search", async () => {
  const f = await fixture(), now = Date.UTC(2026, 0, 1);
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], now: () => now, validateSources: async () => true });
    let checks = 0;
    const result = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", now: () => now + 30 * 86400000 + 1,
      validateSources: async () => { checks++; return true; } }, result => result);
    expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]); expect(checks).toBe(0);
    expect(result.reason).toBe("retention-expired");
  } finally { f.close(); }
});
test("scope changes and final source confirmation refuse cached excerpts", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources: async () => true });
    const changed = await searchValidatedEvidenceGeneration({ ...f, scopeHash: "c".repeat(64), query: "retrieval", validateSources: async () => true }, result => result);
    expect(changed.items).toEqual([]); expect(changed.reason).toBe("index-incompatible");
    const stale = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", confirmSources: () => false, validateSources: async () => true }, result => result);
    expect(stale.items).toEqual([]); expect(stale.reason).toBe("stale-source");
  } finally { f.close(); }
});


test("CURRENT is pinned before reading so a foreign collector cannot delete the snapshot", async () => {
  const f = await fixture(), foreign = openEvidenceStorage(f.store.projectRoot);
  const collector = createEvidenceLifecycle(foreign);
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources: async () => true });
    let collected: string | undefined;
    const store = { ...f.store, read(name: string, cap: number) {
      const bytes = f.store.read(name, cap);
      if (name === "CURRENT") collected = collector.collectSuperseded();
      return bytes;
    } };
    const result = await searchValidatedEvidenceGeneration({ ...f, store, query: "retrieval",
      validateSources: async () => true }, result => result);
    expect(collected).toBe("deferred");
    expect(result.code).toBe("ok");
    expect(result.items[0]?.text).toBe(document.text);
    expect(collector.collectSuperseded()).toBe("collected");
  } finally { collector.close(); foreign.close(); f.close(); }
});

test("all post-load refusal paths retain the selected generation", async () => {
  const f = await fixture();
  try {
    const built = await publishValidatedEvidenceGeneration({ ...f, documents: [document], validateSources: async () => true });
    for (const override of [{ scopeHash: "c".repeat(64) }, { validateSources: async () => false },
      { confirmSources: () => false }, { now: () => Date.now() + 31 * 86400000 }]) {
      const result = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", validateSources: async () => true,
        ...override }, result => result);
      expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]);
      expect(result.generation).toBe(built.generation);
    }
  } finally { f.close(); }
});


test("embedding deadline aborts callback, releases pins and refuses a late publication", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined, signal: AbortSignal | undefined;
  try {
    await expect(publishValidatedEvidenceGeneration({ ...f, documents: [document], timeoutMs: 100,
      validateSources: async () => true, buildVectors: async (_chunks, _previous, active) => {
        signal = active;
        await new Promise<void>(resolve => { finish = resolve; });
        return undefined;
      } })).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(f.store.read("CURRENT", 4096)).toBeUndefined();
    const release = f.store.pinReaders(true); expect(release).toBeDefined(); release?.();
    finish?.(); await Bun.sleep(5);
    expect(f.store.read("CURRENT", 4096)).toBeUndefined();
  } finally { finish?.(); f.close(); }
});

test("revocation cancels pending embeddings and drains without waiting for model completion", async () => {
  const f = await fixture();
  let finish: (() => void) | undefined, signal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  try {
    const build = publishValidatedEvidenceGeneration({ ...f, documents: [document],
      validateSources: async () => true, buildVectors: async (_chunks, _previous, active) => {
        signal = active; started();
        await new Promise<void>(resolve => { finish = resolve; });
        return undefined;
      } });
    const settled = build.then(() => undefined, (error: unknown) => error);
    await ready;
    await f.lifecycle.revokeAndDrain(scope);
    expect(await settled).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    expect(f.store.read("CURRENT", 4096)).toBeUndefined();
    finish?.(); await Bun.sleep(5);
    expect(f.store.read("CURRENT", 4096)).toBeUndefined();
  } finally { finish?.(); f.close(); }
});

function archiveDocument(texts: string[], versionHash: string,
  options: { identity?: { dev: number; ino: number }; ignoredPrefix?: string } = {}) {
  const prefix = options.ignoredPrefix ?? "";
  let offset = Buffer.byteLength(prefix);
  const bytes = Buffer.from(prefix + texts.map(text => JSON.stringify({ role: "user", text }) + "\n").join(""));
  const identity = options.identity ?? { dev: 1, ino: 42 };
  return { archiveCheckpoint: createArchiveCheckpoint(bytes, identity),
    canReuseArchive: (previous: unknown) => canAppendArchive(bytes, identity, previous), sourceId: document.sourceId, sourcePath: document.sourcePath, scope, versionHash,
    records: texts.map(text => {
      const raw = Buffer.from(JSON.stringify({ role: "user", text }));
      const startByte = offset; offset += raw.length + 1;
      return { text, role: "user", timestamp: null, redaction: "not-needed" as const, trustedAsPolicy: false as const,
        recordId: `${startByte}:${createHash("sha256").update(raw).digest("hex")}`, startByte, endByte: offset };
    }) };
}

test("atomic append reuses complete records and rebinds old citations to the full source hash", async () => {
  const f = await fixture();
  try {
    const first = await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["old retrieval"], "a".repeat(64))], validateSources: async () => true });
    expect(first.reusedArchiveChunks).toBe(0);
    const second = await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["old retrieval", "new retrieval"], "d".repeat(64))], validateSources: async () => true });
    expect(second.reusedArchiveChunks).toBe(1); expect(second.chunkCount).toBe(2);
    const result = await searchValidatedEvidenceGeneration({ ...f, query: "old", validateSources: async () => true }, r => r);
    expect(result.code).toBe("ok"); expect(result.items[0]?.versionHash).toBe("d".repeat(64));
    const oldBytes = f.store.read(first.generation, 65536)!;
    expect(JSON.parse(oldBytes.toString()).chunks[0].versionHash).toBe("a".repeat(64));
    const pointer = f.store.read("CURRENT", 4096)!;
    await expect(publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["old retrieval", "new retrieval", "late retrieval"], "e".repeat(64))],
      validateSources: async () => false })).rejects.toThrow();
    expect(f.store.read("CURRENT", 4096)).toEqual(pointer);
  } finally { f.close(); }
});

test("rewrite/delete and incompatible scope never merge old archive records", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["removed retrieval", "retained retrieval"], "a".repeat(64))], validateSources: async () => true });
    const rewritten = await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["replacement retrieval"], "d".repeat(64))], validateSources: async () => true });
    expect(rewritten.reusedArchiveChunks).toBe(0); expect(rewritten.chunkCount).toBe(1);
    const removed = await searchValidatedEvidenceGeneration({ ...f, query: "removed", validateSources: async () => true }, r => r);
    expect(removed.items).toEqual([]);
    const changed = await publishValidatedEvidenceGeneration({ ...f, scopeHash: "c".repeat(64),
      documents: [archiveDocument(["replacement retrieval"], "e".repeat(64))], validateSources: async () => true });
    expect(changed.reusedArchiveChunks).toBe(0);
    await publishValidatedEvidenceGeneration({ ...f, documents: [], validateSources: async () => true });
    const empty = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", validateSources: async () => true }, r => r);
    expect(empty.items).toEqual([]);
  } finally { f.close(); }
});

test("corrupt prior generation is replaced without archive reuse", async () => {
  const f = await fixture();
  try {
    const first = await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["retrieval"], "a".repeat(64))], validateSources: async () => true });
    f.store.withWriter(() => f.store.writeAtomic(first.generation, Buffer.from("corrupt")));
    const second = await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["retrieval"], "d".repeat(64))], validateSources: async () => true });
    expect(second.reusedArchiveChunks).toBe(0); expect(second.chunkCount).toBe(1);
  } finally { f.close(); }
});

test("replaced file identity refuses reuse despite identical complete records", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["retrieval"], "a".repeat(64))], validateSources: async () => true });
    const next = await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["retrieval", "new retrieval"], "d".repeat(64), { identity: { dev: 1, ino: 43 } })],
      validateSources: async () => true });
    expect(next.reusedArchiveChunks).toBe(0); expect(next.chunkCount).toBe(2);
  } finally { f.close(); }
});

test("rewrite of ignored raw prefix refuses reuse of unchanged projected records", async () => {
  const f = await fixture();
  try {
    await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["retrieval"], "a".repeat(64), { ignoredPrefix: "ignored-a\n" })],
      validateSources: async () => true });
    const next = await publishValidatedEvidenceGeneration({ ...f,
      documents: [archiveDocument(["retrieval", "new retrieval"], "d".repeat(64), { ignoredPrefix: "ignored-b\n" })],
      validateSources: async () => true });
    expect(next.reusedArchiveChunks).toBe(0); expect(next.chunkCount).toBe(2);
    const result = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", validateSources: async () => true }, r => r);
    expect(result.items.every(item => item.versionHash === "d".repeat(64))).toBe(true);
  } finally { f.close(); }
});


test("forceFull matches incremental projections across source mutations without prior vectors", async () => {
  const f = await fixture();
  try {
    for (const documents of [
      [archiveDocument(["old retrieval"], "a".repeat(64))],
      [archiveDocument(["old retrieval", "new retrieval"], "b".repeat(64))],
      [archiveDocument(["replacement retrieval"], "c".repeat(64))],
      [],
    ]) {
      const incremental = await publishValidatedEvidenceGeneration({ ...f, documents, validateSources: async () => true });
      const expected = JSON.parse(f.store.read(incremental.generation, 65536)!.toString());
      let previousWasAbsent = false;
      const full = await publishValidatedEvidenceGeneration({ ...f, documents, forceFull: true,
        validateSources: async () => true, buildVectors: async (_chunks, previous) => {
          previousWasAbsent = previous === undefined; return undefined;
        } });
      const actual = JSON.parse(f.store.read(full.generation, 65536)!.toString());
      expect(full.reusedArchiveChunks).toBe(0);
      expect(previousWasAbsent).toBe(true);
      expect(actual.chunks).toEqual(expected.chunks);
      expect(actual.validation).toEqual(expected.validation);
    }
  } finally { f.close(); }
});
