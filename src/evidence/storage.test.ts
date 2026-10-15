import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openEvidenceStorage } from "./storage";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), "erl-storage-")); roots.push(root); return root; }
test("atomic bytes persist across reopen", async () => {
  const root = await fixture(), store = openEvidenceStorage(root);
  try { store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from("scoped"))); expect(store.read("ledger.json", 20)?.toString()).toBe("scoped"); }
  finally { store.close(); }
  const next = openEvidenceStorage(root);
  try { expect(next.read("ledger.json", 20)?.toString()).toBe("scoped"); expect(next.read("absent", 20)).toBeUndefined(); }
  finally { next.close(); }
});
test("writer lease excludes another descriptor and releases on throw", async () => {
  const root = await fixture(), first = openEvidenceStorage(root), second = openEvidenceStorage(root);
  try {
    expect(() => first.writeAtomic("unleased", Buffer.from("no"))).toThrow();
    first.withWriter(() => { expect(() => second.withWriter(() => {})).toThrow(); });
    expect(() => first.withWriter(() => { throw new Error("fault"); })).toThrow();
    expect(() => second.withWriter(() => second.writeAtomic("ok", Buffer.from("yes")))).not.toThrow();
  } finally { first.close(); second.close(); }
});
test("failed prepublication flush preserves old bytes", async () => {
  const store = openEvidenceStorage(await fixture());
  try {
    store.withWriter(() => {
      store.writeAtomic("CURRENT", Buffer.from("old"));
      expect(() => store.writeAtomic("CURRENT", Buffer.from("new"), () => { throw new Error("crash"); })).toThrow();
    }); expect(store.read("CURRENT", 20)?.toString()).toBe("old");
  } finally { store.close(); }
});
test("directory replacement refuses reads and writes without following replacement", async () => {
  const root = await fixture(), store = openEvidenceStorage(root), external = path.join(root, "external");
  try {
    await mkdir(external); await writeFile(path.join(external, "ledger.json"), "foreign");
    await rename(path.join(root, ".metaproject/evidence"), path.join(root, "old"));
    await symlink(external, path.join(root, ".metaproject/evidence"));
    expect(() => store.read("ledger.json", 20)).toThrow();
    expect(() => store.withWriter(() => store.writeAtomic("ledger.json", Buffer.from("bad")))).toThrow();
    expect(await readFile(path.join(external, "ledger.json"), "utf8")).toBe("foreign");
    expect(() => openEvidenceStorage(root)).toThrow();
  } finally { store.close(); }
});
test("final symlink, byte overflow, and unsafe names fail closed", async () => {
  const root = await fixture(), store = openEvidenceStorage(root);
  try {
    const secret = path.join(root, "secret"); await writeFile(secret, "secret");
    await symlink(secret, path.join(root, ".metaproject/evidence/link"));
    expect(() => store.read("link", 20)).toThrow();
    store.withWriter(() => store.writeAtomic("large", Buffer.from("1234")));
    expect(() => store.read("large", 3)).toThrow();
    for (const name of ["../secret", "/secret", "a/b", ".writer", ""]) {
      expect(() => store.read(name, 20)).toThrow();
      expect(() => store.withWriter(() => store.writeAtomic(name, Buffer.from("x")))).toThrow();
    }
  } finally { store.close(); }
});
