import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { createEvidenceLifecycle } from "./lifecycle";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "erl-ledger-")); roots.push(root); return root; }
const source = { kind: "session-archive" as const, id: "session-1" };
test("read-only lifecycle never initializes or repairs ledger state", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    expect(() => createEvidenceLifecycle(store, { create: false })).toThrow();
    expect(store.read("ledger.json", 300000)).toBeUndefined();
    expect(store.read("ledger-initialized", 1)).toBeUndefined();
    store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from(JSON.stringify({ version: 1, revision: 0, revoked: [] }))));
    expect(() => createEvidenceLifecycle(store, { create: false })).toThrow();
    expect(store.read("ledger-initialized", 1)).toBeUndefined();
    const created = createEvidenceLifecycle(store); created.close();
    const existing = createEvidenceLifecycle(store, { create: false });
    const reader = existing.beginReader(source); reader.close(); existing.close();
  } finally { store.close(); }
});
test("creation refuses corrupt ledger before writing initialization marker", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from("{}")));
    expect(() => createEvidenceLifecycle(store)).toThrow();
    expect(store.read("ledger-initialized", 1)).toBeUndefined();
  } finally { store.close(); }
});
test("durable tombstone survives reopening", async () => {
  const root = await fixture(), store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  await lifecycle.revokeAndDrain(source); expect(() => lifecycle.beginReader(source)).toThrow();
  const other = lifecycle.beginReader({ ...source, id: "session-2" }); other.close(); lifecycle.close(); store.close();
  const reopened = openEvidenceStorage(root), next = createEvidenceLifecycle(reopened);
  expect(() => next.beginReader(source)).toThrow(); next.close(); reopened.close();
});
test("session owner revokes archive evidence through the durable lifecycle", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store);
  const result = await lifecycle.sessionOwner.revokeSessionEvidence("session-1");
  expect(result).toEqual({ code: "revoked" });
  expect(() => lifecycle.beginReader(source)).toThrow();
  lifecycle.close(); store.close();
});
test("persist then cancel then drain, never deliver revoked excerpts", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store), reader = lifecycle.beginReader(source);
  const events: string[] = []; const pending = lifecycle.revokeAndDrain(source).then(() => { events.push("drained"); });
  expect(reader.signal.aborted).toBe(true); expect(store.read("ledger.json", 65536)).toBeDefined();
  expect(() => reader.deliver(() => "old excerpt")).toThrow();
  expect(store.pinReaders(true)).toBeUndefined();
  await new Promise<void>(resolve => setImmediate(resolve)); events.push("reader-closing");
  reader.close(); await pending; expect(events).toEqual(["reader-closing", "drained"]); lifecycle.close(); store.close();
});
test("independent handles recheck ledger and observe foreign reader pins", async () => {
  const root = await fixture(), a = openEvidenceStorage(root), b = openEvidenceStorage(root);
  const first = createEvidenceLifecycle(a), second = createEvidenceLifecycle(b), reader = first.beginReader(source);
  const pending = second.revokeAndDrain(source); expect(() => reader.deliver(() => "stale")).toThrow();
  reader.close(); await pending; first.close(); second.close(); a.close(); b.close();
});
test("corrupt or missing initialized ledger refuses reads", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store);
  store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from("{}"))); expect(() => lifecycle.beginReader(source)).toThrow();
  store.withWriter(() => store.remove("ledger.json")); expect(() => lifecycle.beginReader(source)).toThrow(); lifecycle.close(); store.close();
});
test("reader lease excludes drain; asynchronous delivery is forbidden", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store), reader = lifecycle.beginReader(source);
  expect(store.pinReaders(true)).toBeUndefined(); expect(() => reader.deliver(() => Promise.resolve("invalid"))).toThrow();
  reader.close(); const drain = store.pinReaders(true); expect(drain).toBeDefined(); drain?.(); lifecycle.close(); store.close();
});
test("invalid source keys are refused", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store);
  expect(() => lifecycle.beginReader({ kind: "file", id: "../escape" })).toThrow(); lifecycle.close(); store.close();
});

test("lock replacement refuses drain and new handles", async () => {
  for (const name of [".readers", ".writer"]) {
    const root = await fixture(), store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
    const reader = lifecycle.beginReader(source), target = path.join(root, ".metaproject/evidence", name);
    await rename(target, `${target}.old`); await writeFile(target, "", { mode: 0o600 });
    await expect(lifecycle.revokeAndDrain(source)).rejects.toThrow();
    expect(() => openEvidenceStorage(root)).toThrow(); expect(() => reader.deliver(() => "old")).toThrow();
    reader.close(); lifecycle.close(); store.close();
  }
});
test("storage cannot unload its FFI while pins remain", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store), reader = lifecycle.beginReader(source);
  expect(() => store.close()).toThrow(); reader.close(); lifecycle.close(); store.close();
});
test("observed tombstones cannot disappear at the same revision", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store);
  await lifecycle.revokeAndDrain(source);
  store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from(JSON.stringify({ version: 1, revision: 1, revoked: [] }))));
  expect(() => lifecycle.beginReader(source)).toThrow(); lifecycle.close(); store.close();
});
test("maximum ledger size remains readable across reopen", async () => {
  const root = await fixture(), store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  const revoked = Array.from({ length: 4095 }, (_, i) => i.toString(16).padStart(64, "0"));
  store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from(JSON.stringify({ version: 1, revision: 4095, revoked }))));
  await lifecycle.revokeAndDrain(source); lifecycle.close(); store.close();
  const reopened = openEvidenceStorage(root), next = createEvidenceLifecycle(reopened);
  expect(() => next.beginReader(source)).toThrow(); next.close(); reopened.close();
});


test("superseded collection preserves CURRENT and ledger and defers for foreign readers", async () => {
  const root = await fixture(), store = openEvidenceStorage(root), foreign = openEvidenceStorage(root);
  const lifecycle = createEvidenceLifecycle(store), other = createEvidenceLifecycle(foreign);
  const active = `gen-${"a".repeat(64)}.json`, old = `gen-${"b".repeat(64)}.json`;
  const pointer = Buffer.from(JSON.stringify({ schemaVersion: 1, generation: active, sha256: createHash("sha256").update("active").digest("hex") }));
  store.withWriter(() => {
    store.writeAtomic(active, Buffer.from("active")); store.writeAtomic(old, Buffer.from("old"));
    store.writeAtomic("CURRENT", pointer);
  });
  const reader = other.beginReader(source), ledger = store.read("ledger.json", 300000);
  expect(lifecycle.collectSuperseded()).toBe("deferred");
  expect(store.read(old, 20)?.toString()).toBe("old");
  reader.close();
  expect(lifecycle.collectSuperseded()).toBe("collected");
  expect(store.read(old, 20)).toBeUndefined();
  expect(store.read(active, 20)?.toString()).toBe("active");
  expect(store.read("CURRENT", 4096)).toEqual(pointer);
  expect(store.read("ledger.json", 300000)).toEqual(ledger);
  store.withWriter(() => { store.writeAtomic(old, Buffer.from("old")); store.writeAtomic("CURRENT", Buffer.from("{}")); });
  expect(() => lifecycle.collectSuperseded()).toThrow();
  expect(store.read(old, 20)?.toString()).toBe("old");
  lifecycle.close(); other.close(); store.close(); foreign.close();
});


test("conditional clear decides under writer lease and does not invalidate healthy readers", async () => {
  const store = openEvidenceStorage(await fixture()), lifecycle = createEvidenceLifecycle(store);
  const reader = lifecycle.beginReader(source), epoch = lifecycle.currentEpoch();
  try {
    let exclusive = false;
    expect(await lifecycle.clearDerived(5000, () => {
      try { store.withWriter(() => {}); } catch { exclusive = true; }
      return false;
    })).toBe(false);
    expect(exclusive).toBe(true); expect(lifecycle.currentEpoch()).toBe(epoch);
    expect(reader.deliver(() => "still eligible")).toBe("still eligible");
  } finally { reader.close(); lifecycle.close(); store.close(); }
});


test("dotted session ID revocation persists across lifecycle reopen", async () => {
  const root = await fixture(), store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  const scope = { kind: "session-archive" as const, id: "session.1" };
  try {
    const reader = lifecycle.beginReader(scope); reader.close();
    expect(await lifecycle.sessionOwner.revokeSessionEvidence(scope.id)).toEqual({ code: "revoked" });
    expect(() => lifecycle.beginReader(scope)).toThrow();
  } finally { lifecycle.close(); store.close(); }
  const reopened = openEvidenceStorage(root), next = createEvidenceLifecycle(reopened);
  try { expect(() => next.beginReader(scope)).toThrow(); }
  finally { next.close(); reopened.close(); }
});

test("writer contention does not poison retained lifecycle or active readers", async () => {
  const root = await fixture(), store = openEvidenceStorage(root), foreign = openEvidenceStorage(root);
  const lifecycle = createEvidenceLifecycle(store), reader = lifecycle.beginReader(source);
  try {
    for (const action of [() => lifecycle.revokeAndDrain(source), () => lifecycle.clearDerived()]) {
      const before = store.read("ledger.json", 300000);
      let pending: Promise<unknown> | undefined;
      foreign.withWriter(() => { pending = action(); });
      await expect(pending!).rejects.toThrow("evidence writer busy");
      expect(store.read("ledger.json", 300000)).toEqual(before);
      expect(reader.signal.aborted).toBe(false);
      expect(reader.deliver(() => "still eligible")).toBe("still eligible");
      const next = lifecycle.beginReader(source); next.close();
    }
    reader.close();
    await lifecycle.revokeAndDrain(source);
    expect(() => lifecycle.beginReader(source)).toThrow();
  } finally { reader.close(); lifecycle.close(); store.close(); foreign.close(); }
});
