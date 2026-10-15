import { expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
import { createEvidenceLifecycle } from "./lifecycle";
import { publishValidatedEvidenceGeneration } from "./index";
const document = { sourceId: "source", sourcePath: "docs/a", versionHash: "a".repeat(64), text: "apple orchard", scope: { kind: "file" as const, id: "docs/a" } };
test("build leases exclude own and foreign handles without blocking ledger writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-build-lease-"));
  const a = openEvidenceStorage(root), b = openEvidenceStorage(root);
  const lease = a.acquireBuild();
  try {
    expect(() => a.acquireBuild()).toThrow("build busy");
    expect(() => b.acquireBuild()).toThrow("build busy");
    expect(() => a.close()).toThrow("leases active");
    expect(() => b.checkBuildLease(lease)).toThrow("lease required");
    b.withWriter(() => b.writeAtomic("test.json", Buffer.from("tombstone")));
    expect(a.read("test.json", 100)?.toString()).toBe("tombstone");
    lease.release(); lease.release();
    expect(() => a.checkBuildLease(lease)).toThrow("lease required");
    const next = b.acquireBuild(); next.release();
  } finally { lease.release(); a.close(); b.close(); await rm(root, { recursive: true, force: true }); }
});
test("pending embedding serializes builds while revocation cancels and drains immediately", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-build-revoke-"));
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const pending = new Promise<undefined>(resolve => { finish = () => resolve(undefined); });
  const options = { store, lifecycle, timeoutMs: 30000, scopeHash: "b".repeat(64), documents: [document], confirmSources: () => true, validateSources: async () => true };
  const build = publishValidatedEvidenceGeneration({ ...options, buildVectors: async () => { started(); return pending; } });
  const outcome = build.then(() => undefined, (error: unknown) => error);
  try {
    await Promise.race([entered, build.then(() => { throw Error("build completed before embedding callback"); })]);
    await expect(publishValidatedEvidenceGeneration(options)).rejects.toThrow("build busy");
    await lifecycle.revokeAndDrain(document.scope, 1000);
    expect(await outcome).toBeInstanceOf(Error);
    expect(store.read("CURRENT", 4096)).toBeUndefined();
    expect(() => lifecycle.beginReaders([document.scope])).toThrow("revoked");
    const next = store.acquireBuild(); next.release();
    finish(); await Promise.resolve();
    expect(store.read("CURRENT", 4096)).toBeUndefined();
  } finally { finish(); await build.catch(() => {}); lifecycle.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
test("build callback errors release serialization and preserve the prior CURRENT", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-build-failure-"));
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  const options = { store, lifecycle, scopeHash: "b".repeat(64), documents: [document], confirmSources: () => true, validateSources: async () => true };
  try {
    await publishValidatedEvidenceGeneration(options);
    const current = store.read("CURRENT", 4096);
    await expect(publishValidatedEvidenceGeneration({ ...options, buildVectors: async () => { throw Error("adapter failure"); } })).rejects.toThrow("adapter failure");
    expect(store.read("CURRENT", 4096)).toEqual(current);
    await publishValidatedEvidenceGeneration(options);
  } finally { lifecycle.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
test("loss of a build lock cannot recreate an initialized namespace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-build-identity-"));
  const store = openEvidenceStorage(root), lifecycle = createEvidenceLifecycle(store);
  try {
    await unlink(path.join(root, ".metaproject/evidence/.builder"));
    expect(() => store.acquireBuild()).toThrow();
    expect(() => openEvidenceStorage(root)).toThrow();
  } finally { lifecycle.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
