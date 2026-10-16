import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(path.join(tmpdir(), "erl-clear-")); roots.push(root);
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  const clearing = lifecycle as typeof lifecycle & { clearDerived(timeoutMs?: number): Promise<void> };
  return { root, store, lifecycle, clearing, scopeHash: "b".repeat(64), confirmSources: () => true,
    validateSources: async () => true, close() { lifecycle.close(); store.close(); } };
}
test("clear removes generations and staging, retaining ledger, locks and authoritative sources", async () => {
  const f = await fixture();
  try {
    const first = await publishValidatedEvidenceGeneration({ ...f, documents: [document], now: () => 1000 });
    const second = await publishValidatedEvidenceGeneration({ ...f, documents: [document], now: () => 2000 });
    await writeFile(path.join(f.root, "source.txt"), "authoritative");
    await writeFile(path.join(f.root, ".metaproject/evidence/.tmp-00000000-0000-4000-8000-000000000000"), "staging", { mode: 0o600 });
    await f.clearing.clearDerived();
    expect(f.store.read(first.generation, 65536)).toBeUndefined();
    expect(f.store.read(second.generation, 65536)).toBeUndefined();
    expect(f.store.read("CURRENT", 4096)).toBeUndefined();
    expect((await readdir(path.join(f.root, ".metaproject/evidence"))).sort()).toEqual([".builder", ".locks", ".readers", ".writer", "ledger-initialized", "ledger.json"]);
    expect(await readFile(path.join(f.root, "source.txt"), "utf8")).toBe("authoritative");
    const reader = f.lifecycle.beginReader(scope); reader.close();
  } finally { f.close(); }
});
test("clear persists cancellation before waiting for a foreign reader pin", async () => {
  const f = await fixture(), otherStore = openEvidenceStorage(f.root), other = createEvidenceLifecycle(otherStore);
  const reader = other.beginReader(scope);
  try {
    const events: string[] = []; const clearing = f.clearing.clearDerived().then(() => { events.push("cleared"); });
    expect(() => reader.checkpoint()).toThrow();
    expect(() => other.beginReader(scope)).toThrow();
    expect(f.store.pinReaders(true)).toBeUndefined();
    await new Promise<void>(resolve => setImmediate(resolve)); events.push("reader-closing");
    reader.close(); await clearing; expect(events).toEqual(["reader-closing", "cleared"]);
    const fresh = other.beginReader(scope); fresh.close();
  } finally { reader.close(); other.close(); otherStore.close(); f.close(); }
});
test("clear timeout survives reopening and is recoverable without losing tombstones", async () => {
  const f = await fixture();
  const revoked = { kind: "session-archive" as const, id: "revoked-session" };
  await f.lifecycle.revokeAndDrain(revoked);
  const reader = f.lifecycle.beginReader(scope);
  try {
    await expect(f.clearing.clearDerived(1)).rejects.toThrow(); reader.close();
    const store = openEvidenceStorage(f.root), lifecycle = createEvidenceLifecycle(store);
    try {
      expect(() => lifecycle.beginReader(scope)).toThrow();
      await (lifecycle as typeof lifecycle & { clearDerived(): Promise<void> }).clearDerived();
      const fresh = lifecycle.beginReader(scope); fresh.close();
      expect(() => lifecycle.beginReader(revoked)).toThrow();
    } finally { lifecycle.close(); store.close(); }
  } finally { reader.close(); f.close(); }
});
test("clear during validation never hands off loaded excerpts", async () => {
  const f = await fixture(); let pending: Promise<boolean> | undefined;
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document] });
    const result = await searchValidatedEvidenceGeneration({ ...f, query: "retrieval", validateSources: async () => {
      pending = f.clearing.clearDerived(); return true;
    } }, value => value);
    expect(pending).toBeDefined(); await pending; expect(result.items).toEqual([]); expect(result.code).toBe("source-unavailable");
  } finally { f.close(); }
});
test("revocation collects active and superseded generations and clear retains tombstones", async () => {
  const f = await fixture();
  try {
    const first = await publishValidatedEvidenceGeneration({ ...f, documents: [document], now: () => 1000 });
    const second = await publishValidatedEvidenceGeneration({ ...f, documents: [document], now: () => 2000 });
    await f.lifecycle.revokeAndDrain(scope); await f.clearing.clearDerived();
    expect(f.store.read(first.generation, 65536)).toBeUndefined(); expect(f.store.read(second.generation, 65536)).toBeUndefined();
    expect(() => f.lifecycle.beginReader(scope)).toThrow();
  } finally { f.close(); }
});
test("clear unlinks a derived symlink without touching its target", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, "source.txt"); await writeFile(target, "authoritative");
    await symlink(target, path.join(f.root, `.metaproject/evidence/gen-${"a".repeat(64)}.json`));
    await f.clearing.clearDerived(); expect(await readFile(target, "utf8")).toBe("authoritative");
    await expect(lstat(path.join(f.root, `.metaproject/evidence/gen-${"a".repeat(64)}.json`))).rejects.toThrow();
  } finally { f.close(); }
});
test("physical purge requires both writer lease and exclusive reader pin", async () => {
  const f = await fixture();
  const purge = f.store as typeof f.store & { purgeDerived(maxEntries?: number): void };
  try {
    expect(typeof purge.purgeDerived).toBe("function");
    expect(() => purge.purgeDerived()).toThrow();
    expect(() => f.store.withWriter(() => purge.purgeDerived())).toThrow();
    const release = f.store.pinReaders(true); expect(release).toBeDefined();
    try { expect(() => f.store.withWriter(() => purge.purgeDerived(2))).toThrow(); }
    finally { release?.(); }
  } finally { f.close(); }
});


test("clear between loading a generation and pinning rejects the old snapshot", async () => {
  const f = await fixture(); let pending: Promise<boolean> | undefined;
  try {
    await publishValidatedEvidenceGeneration({ ...f, documents: [document] });
    const store = { ...f.store, read(name: string, maxBytes: number) {
      const bytes = f.store.read(name, maxBytes);
      if (name.startsWith("gen-") && !pending) pending = f.clearing.clearDerived();
      return bytes;
    } };
    const result = await searchValidatedEvidenceGeneration({ ...f, store, query: "retrieval" }, value => value);
    expect(pending).toBeDefined(); await pending;
    expect(result.code).toBe("source-unavailable"); expect(result.items).toEqual([]);
  } finally { f.close(); }
});
for (const field of ["epoch", "clearing"]) test(`reopened ledger refuses null ${field}`, async () => {
  const f = await fixture();
  try {
    f.store.withWriter(() => f.store.writeAtomic("ledger.json", Buffer.from(JSON.stringify({
      version: 1, revision: 1, revoked: [], epoch: 0, clearing: false, [field]: null,
    }))));
    const store = openEvidenceStorage(f.root);
    try { expect(() => createEvidenceLifecycle(store)).toThrow(); }
    finally { store.close(); }
  } finally { f.close(); }
});
