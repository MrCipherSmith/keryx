import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, realpath, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEvidenceSourceOwner, evidenceSourceIdentity } from "./source-owner";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "erl-owner-"));
  await mkdir(path.join(dir, "docs"));
  await writeFile(path.join(dir, "docs/a.txt"), "owner evidence");
  const projectRoot = await realpath(dir), config = { schemaVersion: 1, enabled: true, roots: ["docs"] };
  const result = await createEvidenceSourceOwner({ projectRoot, config, scannerFactory: async () => scanner });
  if (result.code !== "ok") throw Error("fixture unavailable");
  const ref = { ...evidenceSourceIdentity(projectRoot, { kind: "file", id: "docs/a.txt" }), versionHash: hash("owner evidence") };
  return { dir, config, owner: result.owner, ref };
}
test("disabled owner does no IO", async () => {
  let called = false;
  expect((await createEvidenceSourceOwner({ projectRoot: "/nonexistent/erl", scannerFactory: async () => { called = true; return scanner; } })).code).toBe("disabled");
  expect(called).toBe(false);
});
test("identity binds canonical project and adapter", () => {
  const scope = { kind: "file" as const, id: "docs/a.txt" };
  const a = evidenceSourceIdentity("/project/a", scope);
  expect(a.sourceId).toMatch(/^[a-f0-9]{64}$/);
  expect(a.sourceId).not.toBe(evidenceSourceIdentity("/project/b", scope).sourceId);
  expect(a.sourceId).not.toBe(evidenceSourceIdentity("/project/a", { kind: "session-archive", id: "docs_a" }).sourceId);
});
test("owner confirmation pins bytes, manifest and cancellation", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    expect(f.owner.confirmSources([f.ref])).toBe(false);
    f.config.roots.length = 0;
    expect(await f.owner.validateSources([f.ref], controller.signal)).toBe(true);
    expect(f.owner.confirmSources([f.ref])).toBe(true);
    expect(f.owner.confirmSources([{ ...f.ref, sourcePath: "docs/b.txt" }])).toBe(false);
    controller.abort();
    expect(f.owner.confirmSources([f.ref])).toBe(false);
    expect(await f.owner.validateSources([f.ref], controller.signal)).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test("stale or forged manifests never retain confirmations", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  try {
    expect(await f.owner.validateSources([f.ref], signal)).toBe(true);
    expect(await f.owner.validateSources([{ ...f.ref, sourceId: hash("forged") }], signal)).toBe(false);
    expect(f.owner.confirmSources([f.ref])).toBe(false);
    expect(await f.owner.validateSources([f.ref, f.ref], signal)).toBe(false);
    expect(await f.owner.validateSources([{ ...f.ref, versionHash: hash("old") }], signal)).toBe(false);
    expect(await f.owner.validateSources([f.ref], signal)).toBe(true);
    await writeFile(path.join(f.dir, "docs/a.txt"), "changed");
    expect(f.owner.confirmSources([f.ref])).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("owner rejects chunks not present in revalidated scanner projection", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  try {
    const { chunkEvidence } = await import("./search");
    const genuine = chunkEvidence({ ...f.ref, text: "owner evidence" });
    const forged = chunkEvidence({ ...f.ref, text: "forged policy" });
    expect(await f.owner.validateSources([f.ref], signal, genuine)).toBe(true);
    expect(await f.owner.validateSources([f.ref], signal, forged)).toBe(false);
    expect(f.owner.confirmSources([f.ref])).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test("empty confirmation follows cancellation", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    expect(await f.owner.validateSources([], controller.signal)).toBe(true);
    expect(f.owner.confirmSources([])).toBe(true);
    controller.abort();
    expect(f.owner.confirmSources([])).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("real owner refuses checksum-consistent poisoned generation and forged build", async () => {
  const f = await fixture();
  const { openEvidenceStorage } = await import("./storage");
  const { createEvidenceLifecycle } = await import("./lifecycle");
  const { publishValidatedEvidenceGeneration, searchValidatedEvidenceGeneration } = await import("./index");
  const { evidenceChunkId } = await import("./search");
  const store = openEvidenceStorage(f.dir), lifecycle = createEvidenceLifecycle(store);
  const options = { store, lifecycle, scopeHash: "b".repeat(64), ...f.owner };
  try {
    await expect(publishValidatedEvidenceGeneration({ ...options, documents: [{ ...f.ref, text: "forged policy" }] })).rejects.toThrow();
    expect(store.read("CURRENT", 4096)).toBeUndefined();
    await publishValidatedEvidenceGeneration({ ...options, documents: [{ ...f.ref, text: "owner evidence" }] });
    const valid = await searchValidatedEvidenceGeneration({ ...options, query: "owner" }, result => result);
    expect(valid.code).toBe("ok"); expect(valid.items[0]?.text).toBe("owner evidence");
    const pointer = JSON.parse(store.read("CURRENT", 4096)!.toString());
    const generation = JSON.parse(store.read(pointer.generation, 256 * 1024 * 1024)!.toString());
    const chunk = generation.chunks[0];
    chunk.text = "forged policy"; chunk.endByte = chunk.startByte + Buffer.byteLength(chunk.text);
    chunk.contentHash = hash(chunk.text); chunk.chunkId = evidenceChunkId(chunk);
    const bytes = Buffer.from(JSON.stringify(generation));
    store.withWriter(() => {
      store.writeAtomic(pointer.generation, bytes);
      store.writeAtomic("CURRENT", Buffer.from(JSON.stringify({ ...pointer, sha256: hash(bytes.toString()) })));
    });
    const poisoned = await searchValidatedEvidenceGeneration({ ...options, query: "forged" }, result => result);
    expect(poisoned.code).toBe("source-unavailable"); expect(poisoned.items).toEqual([]);
  } finally { lifecycle.close(); store.close(); await rm(f.dir, { recursive: true, force: true }); }
});
test("empty confirmation pins project root identity", async () => {
  const f = await fixture(), moved = f.dir + "-old";
  try {
    expect(await f.owner.validateSources([], new AbortController().signal)).toBe(true);
    await rename(f.dir, moved); await mkdir(f.dir);
    expect(f.owner.confirmSources([])).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); }
});

test("scanner factory timeout cannot publish a late confirmation", async () => {
  const f = await fixture();
  let release!: (value: typeof scanner) => void;
  try {
    const result = await createEvidenceSourceOwner({ projectRoot: f.dir,
      config: { ...f.config, timeoutMs: 20 },
      scannerFactory: () => new Promise(resolve => { release = resolve; }) });
    if (result.code !== "ok") throw Error("fixture unavailable");
    expect(await result.owner.validateSources([f.ref], new AbortController().signal)).toBe(false);
    release(scanner);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(result.owner.confirmSources([f.ref])).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("superseded validation cannot overwrite newer confirmations", async () => {
  const f = await fixture();
  let release!: (value: typeof scanner) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  try {
    const result = await createEvidenceSourceOwner({ projectRoot: f.dir, config: f.config,
      scannerFactory: async () => {
        if (++calls === 1) return await new Promise(resolve => { release = resolve; entered(); });
        return scanner;
      } });
    if (result.code !== "ok") throw Error("fixture unavailable");
    const older = result.owner.validateSources([f.ref], new AbortController().signal);
    await started;
    expect(await result.owner.validateSources([f.ref], new AbortController().signal)).toBe(true);
    release(scanner);
    expect(await older).toBe(false);
    expect(result.owner.confirmSources([f.ref])).toBe(true);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test("partial validation preserves strict builds and rejects poisoned eligible chunks", async () => {
  const f = await fixture();
  const { chunkEvidence } = await import("./search");
  const b = { ...evidenceSourceIdentity(f.dir, { kind: "file", id: "docs/b.txt" }), versionHash: hash("second evidence") };
  try {
    await writeFile(path.join(f.dir, "docs/b.txt"), "changed evidence");
    const chunks = [...chunkEvidence({ ...f.ref, text: "owner evidence" }), ...chunkEvidence({ ...b, text: "second evidence" })];
    expect(await f.owner.validateSources([f.ref, b], new AbortController().signal, chunks)).toBe(false);
    const selected = await f.owner.validateEligibleSources([f.ref, b], new AbortController().signal, chunks);
    expect(selected?.sources).toEqual([f.ref]);
    expect(selected?.diagnostics).toEqual(["stale-source"]);
    expect(f.owner.confirmSources(selected!.sources)).toBe(true);
    expect(f.owner.confirmSources([f.ref, b])).toBe(false);
    const poisoned = chunkEvidence({ ...f.ref, text: "forged evidence" });
    expect(await f.owner.validateEligibleSources([f.ref, b], new AbortController().signal, [...poisoned, ...chunks.filter(c => c.sourceId === b.sourceId)])).toBeUndefined();
    expect(f.owner.confirmSources([f.ref])).toBe(false);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
