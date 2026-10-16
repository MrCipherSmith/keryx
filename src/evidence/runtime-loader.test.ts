import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const moduleName = "./runtime";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-loader-"));
  await mkdir(path.join(root, ".metaproject"));
  return { root, target: path.join(root, ".metaproject/evidence.json"),
    close: () => rm(root, { recursive: true, force: true }) };
}
test("absent and explicit disabled runtime config create no derived storage or scanner", async () => {
  const f = await fixture();
  const { loadEvidenceRuntime } = await import(moduleName);
  try {
    for (const explicit of [false, true]) {
      if (explicit) await writeFile(f.target, JSON.stringify({ schemaVersion: 1, enabled: false }));
      const result = await loadEvidenceRuntime({ projectRoot: f.root,
        scannerFactory: async () => { throw Error("must not scan"); } });
      expect(result.ok).toBe(true);
      expect(await result.runtime.searchPublic("query", (value: any) => value.code)).toBe("disabled");
      result.runtime.close();
      await expect(access(path.join(f.root, ".metaproject/evidence"))).rejects.toThrow();
    }
  } finally { await f.close(); }
});
test("runtime loader refuses malformed, oversized and unknown-field config", async () => {
  const f = await fixture();
  const { loadEvidenceRuntime } = await import(moduleName);
  try {
    for (const body of ["{", " ".repeat(65537), JSON.stringify({ schemaVersion: 1, root: "/private" })]) {
      await writeFile(f.target, body);
      expect(await loadEvidenceRuntime({ projectRoot: f.root })).toEqual({ ok: false, diagnostics: ["invalid-config"] });
    }
    await expect(access(path.join(f.root, ".metaproject/evidence"))).rejects.toThrow();
  } finally { await f.close(); }
});
test("runtime loader rejects a symlink config and symlink config parent", async () => {
  const f = await fixture();
  const { loadEvidenceRuntime } = await import(moduleName);
  try {
    const other = path.join(f.root, "other");
    await mkdir(other);
    const target = path.join(other, "evidence.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1, enabled: true }));
    await symlink(target, f.target);
    expect((await loadEvidenceRuntime({ projectRoot: f.root })).ok).toBe(false);
    await rm(path.join(f.root, ".metaproject"), { recursive: true });
    await symlink(other, path.join(f.root, ".metaproject"));
    expect((await loadEvidenceRuntime({ projectRoot: f.root })).ok).toBe(false);
  } finally { await f.close(); }
});
