import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidenceVectorSnapshot } from "./vector-cache";
import { evidenceVectorKey } from "./hybrid";
import { chunkEvidence } from "./search";
import { createEvidenceEmbeddingBuilder } from "./embedding-builder";
import type { EvidenceVectorIdentity } from "./hybrid";
import { resolveCapability } from "../capability/seam";

function fixture(enabled = true) {
  const root = mkdtempSync(path.join(tmpdir(), "erl-embedding-"));
  mkdirSync(path.join(root, ".metaproject"));
  writeFileSync(path.join(root, ".metaproject/metaproject.json"), JSON.stringify({
    modules: { evidence: { capabilities: [{ id: "fixture-embedding", enabled }] } },
  }));
  const identity: EvidenceVectorIdentity = { project: root, adapter: "fixture-embedding",
    model: "fixture", revision: "1", dimensions: 2, sanitizer: "v1" };
  const chunks = chunkEvidence({ sourceId: "s", sourcePath: "a.txt",
    versionHash: "a".repeat(64), text: "apple orchard" });
  let loads = 0, runs = 0;
  const spec = { id: identity.adapter, load: () => {
    loads++;
    return { id: identity.adapter, isAvailable: async () => true,
      run: async (input: { texts: readonly string[]; signal: AbortSignal }) => {
        runs++; return input.texts.map(() => [1, 0]);
      } };
  } };
  return { root, identity, chunks, spec, counts: () => [loads, runs],
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test("disabled embedding capability performs no adapter work", async () => {
  const f = fixture(false);
  try {
    const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec: f.spec, remote: true, authorizeRemote: async () => true });
    await expect(build(f.chunks, undefined, new AbortController().signal)).rejects.toThrow();
    expect(f.counts()).toEqual([0, 0]);
  } finally { f.close(); }
});

test("remote consent is required before loading or probing an adapter", async () => {
  const f = fixture();
  try {
    const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec: f.spec, remote: true });
    await expect(build(f.chunks, undefined, new AbortController().signal)).rejects.toThrow();
    expect(f.counts()).toEqual([0, 0]);
  } finally { f.close(); }
});

test("compatible vectors are reused without any adapter work", async () => {
  const f = fixture();
  try {
    const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec: f.spec, remote: true, authorizeRemote: async () => true });
    const first = await build(f.chunks, undefined, new AbortController().signal);
    const second = await build(f.chunks, first, new AbortController().signal);
    expect(second).toEqual(first); expect(f.counts()).toEqual([1, 1]);
  } finally { f.close(); }
});


test("remote authorization binds identity before adapter resolution", async () => {
  const f = fixture();
  try {
    const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity,
      spec: f.spec, remote: true, authorizeRemote: async request => {
        expect(request.identity).toEqual(f.identity); expect(request.purpose).toBe("corpus");
        expect(f.counts()).toEqual([0, 0]); return true;
      } });
    expect((await build(f.chunks, undefined, new AbortController().signal)).records).toHaveLength(1);
    expect(f.counts()).toEqual([1, 1]);
  } finally { f.close(); }
});

test("abort releases pending adapter work and rejects a late vector", async () => {
  const f = fixture(), controller = new AbortController();
  let complete!: (value: number[][]) => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const spec = { id: f.identity.adapter, load: () => ({ id: f.identity.adapter,
    isAvailable: async () => true, run: async () => {
      entered(); return new Promise<number[][]>(resolve => { complete = resolve; });
    } }) };
  try {
    const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec, remote: true, authorizeRemote: async () => true });
    const pending = build(f.chunks, undefined, controller.signal);
    await ready; controller.abort();
    await expect(pending).rejects.toThrow("aborted"); complete([[1, 0]]);
    await expect(build(f.chunks, undefined, controller.signal)).rejects.toThrow("aborted");
  } finally { f.close(); }
});

test("malformed model vectors never become a snapshot", async () => {
  const f = fixture();
  try {
    const sparse = new Array<number>(2); sparse[0] = 1;
    for (const output of [[], [[0, 0]], [[1]], [[NaN, 1]], [sparse]]) {
      const spec = { id: f.identity.adapter, load: () => ({ id: f.identity.adapter,
        isAvailable: async () => true, run: async () => output }) };
      const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec, remote: true, authorizeRemote: async () => true });
      await expect(build(f.chunks, undefined, new AbortController().signal)).rejects.toThrow();
    }
  } finally { f.close(); }
});

test("poisoned text, mismatched owner and tiny budgets fail before model work", async () => {
  const f = fixture();
  try {
    const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec: f.spec, remote: true, authorizeRemote: async () => true });
    await expect(build([{ ...f.chunks[0]!, text: "poison" }], undefined, new AbortController().signal)).rejects.toThrow();
    const tiny = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec: f.spec, remote: true, authorizeRemote: async () => true, maxBytes: 1 });
    await expect(tiny(f.chunks, undefined, new AbortController().signal)).rejects.toThrow();
    expect(() => createEvidenceEmbeddingBuilder({ projectRoot: "foreign", identity: f.identity, spec: f.spec, remote: true, authorizeRemote: async () => true })).toThrow();
    expect(f.counts()).toEqual([0, 0]);
  } finally { f.close(); }
});


test("asset-free local model is refused before loading", async () => {
  const f = fixture();
  try {
    const build = createEvidenceEmbeddingBuilder({ projectRoot: f.root, identity: f.identity, spec: f.spec, remote: false });
    await expect(build(f.chunks, undefined, new AbortController().signal)).rejects.toThrow();
    expect(f.counts()).toEqual([0, 0]);
  } finally { f.close(); }
});

test("sparse vectors and sparse record lists are refused", () => {
  const f = fixture();
  try {
    const values = new Array<number>(2); values[0] = 1;
    const hash = f.chunks[0]!.contentHash;
    expect(() => createEvidenceVectorSnapshot(f.identity, [{ contentHash: hash,
      key: evidenceVectorKey(f.identity, hash), values }])).toThrow();
    expect(() => createEvidenceVectorSnapshot(f.identity, new Array(1))).toThrow();
  } finally { f.close(); }
});

test("abort during capability resolution prevents subsequent load and probe", async () => {
  const f = fixture(), controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const spec = { id: f.identity.adapter, load: f.spec.load };
  // Resolution reads id immediately before awaiting manifest I/O. This gate
  // deterministically aborts after the resolver starts, not before its call.
  Object.defineProperty(spec, "id", { get() { entered(); queueMicrotask(() => controller.abort()); return f.identity.adapter; } });
  try {
    const pending = resolveCapability(f.root, spec, controller.signal);
    await ready;
    expect(await pending).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.counts()).toEqual([0, 0]);
  } finally { f.close(); }
});
