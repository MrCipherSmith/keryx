import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const moduleName = "./runtime";
const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
test("automatic opt-in opens runtime", async () => {
  const f = await fixture({ automatic: true });
  try { expect((await f.runtime.buildConfiguredFiles()).code).toBe("ok"); }
  finally { await f.close(); }
});
const file = { kind: "file" as const, id: "docs/a.txt" };
async function fixture(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-runtime-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, file.id), "runtime evidence");
  const config = { schemaVersion: 1, enabled: true, roots: ["docs"], ...extra };
  const { createEvidenceRuntime } = await import(moduleName);
  const result = await createEvidenceRuntime({ projectRoot: root, config, scannerFactory: async () => scanner });
  if (!result.ok) throw Error("fixture unavailable");
  return { root, config, runtime: result.runtime, async close() { result.runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
test("read-only runtime leaves incomplete lifecycle state unchanged", async () => {
  const { openEvidenceStorage } = await import("./storage");
  const { readdir } = await import("node:fs/promises");
  for (const ledger of [undefined, "{}", JSON.stringify({ version: 1, revision: 0, revoked: [] })]) {
    const f = await fixture();
    try {
      const store = openEvidenceStorage(f.root);
      try { if (ledger !== undefined) store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from(ledger))); }
      finally { store.close(); }
      const directory = path.join(f.root, ".metaproject/evidence");
      const before = (await readdir(directory)).sort();
      const result = await f.runtime.search("runtime", (value: any) => value);
      expect(["source-unavailable", "timeout"]).toContain(result.code);
      expect(result.items).toEqual([]);
      expect((await readdir(directory)).sort()).toEqual(before);
      if (ledger !== undefined) expect(await readFile(path.join(directory, "ledger.json"), "utf8")).toBe(ledger);
    } finally { await f.close(); }
  }
});

test("disabled runtime neither opens storage nor starts scanner", async () => {
  const { createEvidenceRuntime } = await import(moduleName);
  const result = await createEvidenceRuntime({ projectRoot: "/nonexistent-erl-runtime", scannerFactory: async () => { throw Error("must not run"); } });
  expect(result.ok).toBe(true);
  expect((await result.runtime.build([file])).code).toBe("disabled");
  expect(await result.runtime.search("runtime", (value: any) => value.code)).toBe("disabled");
  expect((await result.runtime.clear()).code).toBe("disabled");
  result.runtime.close();
});
test("configured file build inventories only trusted roots", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.buildConfiguredFiles()).code).toBe("ok");
    expect(await f.runtime.search("runtime", (value: any) => value.items.map((item: any) => item.sourcePath)))
      .toEqual(["docs/a.txt"]);
  } finally { await f.close(); }
});
test("runtime composes verified build, delivery, stale refusal and clear", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.build([file])).code).toBe("ok");
    expect(await f.runtime.search("runtime", (value: any) => value.items[0]?.text)).toBe("runtime evidence");
    await writeFile(path.join(f.root, file.id), "changed evidence");
    expect(await f.runtime.search("runtime", (value: any) => [value.code, value.items.length])).toEqual(["source-unavailable", 0]);
    expect((await f.runtime.clear()).code).toBe("ok");
    expect(await f.runtime.search("runtime", (value: any) => value.code)).toBe("index-absent");
  } finally { await f.close(); }
});
test("failed full build preserves CURRENT and config is a private snapshot", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.build([file])).code).toBe("ok");
    const target = path.join(f.root, ".metaproject/evidence/CURRENT"), before = await readFile(target);
    f.config.roots.push("private");
    expect((await f.runtime.build([{ kind: "file", id: "../secret" }])).code).toBe("source-unavailable");
    expect((await f.runtime.build([{ kind: "file", id: "private/a.txt" }])).code).toBe("source-unavailable");
    expect(await readFile(target)).toEqual(before);
  } finally { await f.close(); }
});
test("runtime enforces aggregate delivery and publication budgets", async () => {
  const f = await fixture({ maxTokens: 3 });
  try {
    expect((await f.runtime.build([file])).code).toBe("ok");
    expect(await f.runtime.searchPublic("runtime", (value: any) => [value.code, value.items.length])).toEqual(["budget-exceeded", 0]);
    expect(await f.runtime.search("runtime", (value: any) => value.items.length)).toBe(0);
  } finally { await f.close(); }
  const small = await fixture({ maxIndexBytes: 1 });
  try { expect((await small.runtime.build([file])).code).not.toBe("ok"); }
  finally { await small.close(); }
});
test("aborted build and search disclose no excerpts", async () => {
  const f = await fixture(), controller = new AbortController();
  controller.abort();
  try {
    expect((await f.runtime.build([file], controller.signal)).code).toBe("timeout");
    expect(await f.runtime.search("runtime", (value: any) => [value.code, value.items.length], controller.signal)).toEqual(["timeout", 0]);
  } finally { await f.close(); }
});
test("runtime scopes configuration compatibility and rejects async delivery", async () => {
  const f = await fixture();
  let other;
  try {
    expect((await f.runtime.build([file])).code).toBe("ok");
    const { createEvidenceRuntime } = await import(moduleName);
    other = await createEvidenceRuntime({ projectRoot: f.root, config: { ...f.config, maxTokens: 10 }, scannerFactory: async () => scanner });
    expect(await other.runtime.search("runtime", (value: any) => [value.code, value.reason])).toEqual(["source-unavailable", "index-incompatible"]);
    await expect(f.runtime.search("runtime", async () => undefined)).rejects.toThrow("synchronous");
  } finally { other?.runtime.close(); await f.close(); }
});
test("empty full build is checksum verified and remains searchable", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.build([])).code).toBe("ok");
    expect(await f.runtime.search("runtime", (value: any) => [value.code, value.items.length])).toEqual(["ok", 0]);
  } finally { await f.close(); }
});

test("clear invalidates an in-flight collection without resurrecting CURRENT", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-runtime-clear-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, file.id), "runtime evidence");
  const { createEvidenceRuntime } = await import(moduleName);
  const config = { schemaVersion: 1, enabled: true, roots: ["docs"], timeoutMs: 1000 };
  const builder = await createEvidenceRuntime({ projectRoot: root, config,
    scannerFactory: async () => { started(); await gate; return scanner; } });
  const clearer = await createEvidenceRuntime({ projectRoot: root, config, scannerFactory: async () => scanner });
  const pending = builder.runtime.build([file]);
  let clearing: Promise<any> | undefined;
  try {
    await Promise.race([ready, pending.then((result: { code: string }) => {
      throw Error(`build completed before collection gate: ${result.code}`);
    })]);
    clearing = clearer.runtime.clear();
    expect(JSON.parse(await readFile(path.join(root, ".metaproject/evidence/ledger.json"), "utf8")).clearing).toBe(true);
    release();
    expect((await pending).code).toBe("source-unavailable");
    expect((await clearing).code).toBe("ok");
    expect(await clearer.runtime.search("runtime", (value: any) => value.code)).toBe("index-absent");
  } finally {
    release(); await pending; await clearing;
    builder.runtime.close(); clearer.runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a failing synchronous transport is never invoked twice", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.build([file])).code).toBe("ok");
    let calls = 0;
    await expect(f.runtime.search("runtime", () => { calls++; throw Error("transport failed"); })).rejects.toThrow("transport failed");
    expect(calls).toBe(1);
    expect(await f.runtime.search("runtime", (value: any) => value.code)).toBe("ok");
  } finally { await f.close(); }
});

test("clear during final owner validation cannot publish a collection from the old epoch", async () => {
  const f = await fixture();
  const { createEvidenceRuntime } = await import(moduleName);
  let calls = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const builder = await createEvidenceRuntime({ projectRoot: f.root, config: f.config,
    scannerFactory: async () => {
      if (++calls === 2) { started(); await gate; }
      return scanner;
    } });
  if (!builder.ok) throw Error("builder unavailable");
  const pending = builder.runtime.build([file]);
  let clearing: Promise<any> | undefined;
  try {
    await Promise.race([ready, pending.then((result: { code: string }) => {
      throw Error(`build completed before final validation gate: ${result.code}`);
    })]);
    clearing = f.runtime.clear();
    expect(JSON.parse(await readFile(path.join(f.root, ".metaproject/evidence/ledger.json"), "utf8")).clearing).toBe(true);
    release();
    expect((await pending).code).toBe("source-unavailable");
    expect((await clearing).code).toBe("ok");
    expect(await f.runtime.search("runtime", (value: any) => value.code)).toBe("index-absent");
    expect(calls).toBe(2);
  } finally {
    release(); await pending; await clearing;
    builder.runtime.close(); await f.close();
  }
});

test("public runtime emits closed citations, real scores and empty-corpus distinction", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.build([file])).code).toBe("ok");
    await f.runtime.searchPublic("runtime", (value: any) => {
      expect(value.code).toBe("ok"); expect(value.items[0].score).toBeGreaterThan(0);
      expect(value.items[0].locator.kind).toBe("file"); expect("startByte" in value.items[0]).toBe(false);
    });
    expect(await f.runtime.searchPublic("unrelated", (value: any) => [value.code, value.diagnostics])).toEqual(["no-match", []]);
    expect((await f.runtime.build([])).code).toBe("ok");
    expect(await f.runtime.searchPublic("runtime", (value: any) => [value.code, value.diagnostics])).toEqual(["no-match", ["empty-corpus"]]);
    await expect(f.runtime.searchPublic("runtime", async () => undefined)).rejects.toThrow("synchronous");
  } finally { await f.close(); }
});

test("public search limit is enforced before packing and cannot exceed configured cap", async () => {
  const f = await fixture({ maxResults: 2 });
  try {
    await writeFile(path.join(f.root, "docs/b.txt"), "runtime evidence second");
    expect((await f.runtime.build([file, { kind: "file", id: "docs/b.txt" }])).code).toBe("ok");
    expect(await f.runtime.searchPublic("runtime", (value: any) => value.items.length)).toBe(2);
    expect(await f.runtime.searchPublic("runtime", (value: any) => value.items.length, undefined, 1)).toBe(1);
    for (const limit of [0, 3, 1.5, NaN]) {
      expect(await f.runtime.searchPublic("runtime", (value: any) => [value.code, value.items.length], undefined, limit))
        .toEqual(["budget-exceeded", 0]);
    }
  } finally { await f.close(); }
});


test("enabled search without CURRENT creates no namespace and starts no scanner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-absent-"));
  const { createEvidenceRuntime } = await import(moduleName);
  let calls = 0;
  const result = await createEvidenceRuntime({ projectRoot: root,
    config: { schemaVersion: 1, enabled: true, roots: ["docs"] },
    scannerFactory: async () => { calls++; return scanner; } });
  try {
    expect(await result.runtime.search("evidence", (value: any) => value.code)).toBe("index-absent");
    expect(result.runtime.status()).toEqual({ code: "index-absent", mode: "lexical", model: null });
    expect(calls).toBe(0);
    await expect(readFile(path.join(root, ".metaproject/evidence/ledger.json"))).rejects.toThrow();
    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(root, ".metaproject/evidence"))).rejects.toThrow();
  } finally { result.runtime.close(); await rm(root, { recursive: true, force: true }); }
});

 test("expired configured-build deadline cannot reset the budget or create storage", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.build([file], undefined, performance.now() - 1)).code).toBe("timeout");
    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(f.root, ".metaproject/evidence"))).rejects.toThrow();
  } finally { await f.close(); }
});

test("invalid build arguments cannot wedge the runtime busy lease", async () => {
  const f = await fixture();
  try {
    expect((await f.runtime.build([file], undefined, Symbol("invalid") as unknown as number)).code).toBe("source-unavailable");
    expect((await f.runtime.build([file], {} as AbortSignal)).code).toBe("source-unavailable");
    expect((await f.runtime.build([file], undefined, NaN)).code).toBe("source-unavailable");
    expect((await f.runtime.build([file], undefined, performance.now() - 1)).code).toBe("timeout");
    expect(f.runtime.status().code).toBe("index-absent");
  } finally { await f.close(); }
});


test("runtime owner revocation persists across restart without deleting source bytes", async () => {
  const f = await fixture();
  const { openEvidenceStorage } = await import("./storage");
  const { createEvidenceLifecycle } = await import("./lifecycle");
  try {
    expect((await f.runtime.revokeSessionEvidence("../invalid")).code).toBe("invalid-session");
    expect(f.runtime.status().code).toBe("index-absent");
    expect((await f.runtime.revokeSessionEvidence("session-1")).code).toBe("revoked");
    expect(await readFile(path.join(f.root, file.id), "utf8")).toBe("runtime evidence");
    expect(f.runtime.status().code).toBe("index-absent");
    f.runtime.close();
    const store = openEvidenceStorage(f.root, false);
    const lifecycle = createEvidenceLifecycle(store, { create: false });
    try {
      expect(() => lifecycle.beginReader({ kind: "session-archive", id: "session-1" })).toThrow("revoked");
    } finally { lifecycle.close(); store.close(); }
    expect((await f.runtime.revokeSessionEvidence("session-2")).code).toBe("unavailable");
  } finally { await f.close(); }
});

test("runtime owner invalidates an active build before reporting revocation success", async () => {
  const f = await fixture();
  const { createEvidenceRuntime } = await import(moduleName);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const builder = await createEvidenceRuntime({ projectRoot: f.root, config: f.config,
    scannerFactory: async () => { entered(); await gate; return scanner; } });
  const pending = builder.runtime.build([file]);
  let revocation: ReturnType<typeof f.runtime.revokeSessionEvidence> | undefined;
  try {
    await Promise.race([ready, pending.then(() => { throw Error("build missed owner gate"); })]);
    revocation = f.runtime.revokeSessionEvidence("session-1");
    expect(() => f.runtime.close()).toThrow("active");
    expect(JSON.parse(await readFile(path.join(f.root, ".metaproject/evidence/ledger.json"), "utf8")).clearing).toBe(true);
    release();
    expect(["source-unavailable", "timeout"]).toContain((await pending).code);
    expect((await revocation).code).toBe("revoked");
    expect(f.runtime.status().code).toBe("index-absent");
  } finally {
    release(); await pending; await revocation;
    builder.runtime.close(); await f.close();
  }
});


test("public search searches eligible sources and reports partial coverage", async () => {
  const f = await fixture();
  const b = { kind: "file" as const, id: "docs/b.txt" };
  try {
    await writeFile(path.join(f.root, b.id), "second historical evidence");
    expect((await f.runtime.build([file, b])).code).toBe("ok");
    await writeFile(path.join(f.root, b.id), "modified unavailable evidence");
    const hit = await f.runtime.searchPublic("runtime", (value: any) => value);
    expect(hit.code).toBe("ok"); expect(hit.coverage).toBe("partial");
    expect(hit.diagnostics).toEqual(["stale-source"]);
    expect(hit.items.map((item: any) => item.sourcePath)).toEqual([file.id]);
    const absent = await f.runtime.searchPublic("historical", (value: any) => value);
    expect(absent.code).toBe("no-match"); expect(absent.coverage).toBe("partial");
    expect(absent.diagnostics).toEqual(["stale-source"]); expect(absent.items).toEqual([]);
    await rm(path.join(f.root, file.id));
    const withheld = await f.runtime.searchPublic("runtime", (value: any) => value);
    expect(withheld.code).toBe("source-unavailable"); expect(withheld.coverage).toBe("unknown");
    expect(withheld.items).toEqual([]); expect(withheld.diagnostics).toContain("stale-source");
    expect(withheld.diagnostics).toContain("source-unreadable");
  } finally { await f.close(); }
});


test("maintenance does not initialize an absent store or run the scanner", async () => {
  const f = await fixture();
  try {
    expect(await f.runtime.maintenance()).toEqual({ code: "index-absent" });
    const { stat } = await import("node:fs/promises");
    await expect(stat(path.join(f.root, ".metaproject/evidence"))).rejects.toThrow();
  } finally { await f.close(); }
});
test("maintenance physically purges expired CURRENT while preserving sources and tombstones", async () => {
  const f = await fixture();
  const { openEvidenceStorage } = await import("./storage");
  const { createEvidenceLifecycle } = await import("./lifecycle");
  const { publishEvidenceGeneration } = await import("./index");
  try {
    expect((await f.runtime.revokeSessionEvidence("session-1")).code).toBe("revoked");
    const store = openEvidenceStorage(f.root, false);
    try {
      await publishEvidenceGeneration({ store, documents: [], validateSources: async () => true,
        now: () => Date.now() - 31 * 86400000 });
    } finally { store.close(); }
    expect(await f.runtime.maintenance()).toEqual({ code: "ok", outcome: "expired-cleared" });
    expect(f.runtime.status().code).toBe("index-absent");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(path.join(f.root, ".metaproject/evidence"))).some(name => name === "CURRENT" || name.startsWith("gen-") || name.startsWith("stage-"))).toBe(false);
    expect(await readFile(path.join(f.root, file.id), "utf8")).toBe("runtime evidence");
    const reopened = openEvidenceStorage(f.root, false), lifecycle = createEvidenceLifecycle(reopened, { create: false });
    try { expect(() => lifecycle.beginReader({ kind: "session-archive", id: "session-1" })).toThrow("revoked"); }
    finally { lifecycle.close(); reopened.close(); }
  } finally { await f.close(); }
});
test("maintenance preserves a healthy CURRENT and refuses a corrupt one", async () => {
  const f = await fixture();
  const { openEvidenceStorage } = await import("./storage");
  const { publishEvidenceGeneration } = await import("./index");
  try {
    // Exercise retention directly, without an unrelated timed source scan.
    const store = openEvidenceStorage(f.root);
    const { createEvidenceLifecycle } = await import("./lifecycle");
    const lifecycle = createEvidenceLifecycle(store);
    try { await publishEvidenceGeneration({ store, documents: [], validateSources: async () => true }); }
    finally { lifecycle.close(); store.close(); }
    const target = path.join(f.root, ".metaproject/evidence/CURRENT"), before = await readFile(target);
    expect(await f.runtime.maintenance()).toEqual({ code: "ok", outcome: "collected" });
    expect(await readFile(target)).toEqual(before);
    await writeFile(target, "{}");
    expect((await f.runtime.maintenance()).code).toBe("source-unavailable");
    expect(await readFile(target, "utf8")).toBe("{}");
  } finally { await f.close(); }
});

for (const interrupted of [false, true]) test(`maintenance recovers missing CURRENT (interrupted clear: ${interrupted})`, async () => {
  const f = await fixture();
  const { openEvidenceStorage } = await import("./storage");
  const { createEvidenceLifecycle } = await import("./lifecycle");
  const { publishEvidenceGeneration } = await import("./index");
  const store = openEvidenceStorage(f.root), lifecycle = createEvidenceLifecycle(store);
  try {
    const published = await publishEvidenceGeneration({ store, documents: [], validateSources: async () => true });
    if (interrupted) {
      const release = store.pinReaders();
      expect(release).toBeDefined();
      try { await expect(lifecycle.clearDerived(1)).rejects.toThrow("drain timed out"); }
      finally { release?.(); }
    } else store.withWriter(() => store.remove("CURRENT"));
    expect(store.read(published.generation, 65536)).toBeDefined();
    expect(await f.runtime.maintenance()).toEqual({ code: "ok", outcome: "orphan-cleared" });
    expect(store.read(published.generation, 65536)).toBeUndefined();
    const ledger = JSON.parse(store.read("ledger.json", 65536)!.toString());
    expect(ledger.clearing).toBe(false);
    expect(await readFile(path.join(f.root, file.id), "utf8")).toBe("runtime evidence");
  } finally { lifecycle.close(); store.close(); await f.close(); }
});
