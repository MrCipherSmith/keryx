import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSession, persistHistory } from "../session/store";
import { projectSessionsDir } from "../session/paths";
import { createEvidenceRuntime } from "./runtime";
const moduleName = "./inventory";
test("inventory is bounded, deterministic and never authorizes symlinks or denied paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-inventory-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "erl-outside-"));
  try {
    await mkdir(path.join(root, "docs/sub"), { recursive: true });
    await writeFile(path.join(root, "docs/z.txt"), "z");
    await writeFile(path.join(root, "docs/sub/a.txt"), "a");
    await writeFile(path.join(root, "docs/.env"), "secret");
    await writeFile(path.join(outside, "private.txt"), "secret");
    await symlink(outside, path.join(root, "docs/link"));
    const { collectEvidenceFiles } = await import(moduleName);
    const config = { schemaVersion: 1, enabled: true, roots: ["docs", "docs/sub"] };
    const result = await collectEvidenceFiles({ projectRoot: root, config });
    expect(result).toEqual({ code: "ok", scopes: [
      { kind: "file", id: "docs/sub/a.txt" }, { kind: "file", id: "docs/z.txt" },
    ] });
    expect((await collectEvidenceFiles({ projectRoot: root, config: { ...config, maxChunks: 1 } })).code).toBe("budget-exceeded");
    expect((await collectEvidenceFiles({ projectRoot: root, config: { ...config, roots: ["docs/link"] } })).code).toBe("source-unavailable");
    expect((await collectEvidenceFiles({ projectRoot: root, config: { ...config, roots: ["../private"] } })).code).toBe("source-unavailable");
    const abort = new AbortController(); abort.abort();
    expect((await collectEvidenceFiles({ projectRoot: root, config, signal: abort.signal })).code).toBe("timeout");
    for (const roots of [["."], ["./docs"], ["docs/."]]) {
      expect(await collectEvidenceFiles({ projectRoot: root, config: { ...config, roots } })).toEqual({
        code: "ok", scopes: [{ kind: "file", id: "docs/sub/a.txt" }, { kind: "file", id: "docs/z.txt" }],
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test("disabled inventory performs no filesystem operations", async () => {
  const { collectEvidenceFiles } = await import(moduleName);
  expect(await collectEvidenceFiles({ projectRoot: "/nonexistent-erl-inventory" }))
    .toEqual({ code: "disabled", scopes: [] });
});


test("configured inventory discovers only owned archives and runtime searches them", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "erl-archive-inventory-"));
  const root = path.join(base, "project"), other = path.join(base, "other"), dataDir = path.join(base, "data");
  await mkdir(root); await mkdir(other);
  const config = { schemaVersion: 1, enabled: true, sessionArchives: true };
  const { collectEvidenceFiles } = await import(moduleName);
  const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
  try {
    expect(await collectEvidenceFiles({ projectRoot: root, dataDir, config })).toEqual({ code: "ok", scopes: [] });
    for (const id of ["z", "a.1"]) {
      const handle = createSession({ cwd: root, dataDir, id });
      persistHistory(handle, [{ role: "user", content: `archiveneedle ${id}` }]);
    }
    const foreign = createSession({ cwd: other, dataDir, id: "foreign" });
    persistHistory(foreign, [{ role: "user", content: "foreignneedle" }]);
    const sessions = projectSessionsDir(root, dataDir);
    await mkdir(path.join(sessions, "live"));
    await writeFile(path.join(sessions, "live/summary.json"), "{}");
    await symlink(path.join(sessions, "a.1"), path.join(sessions, "linked"));
    expect(await collectEvidenceFiles({ projectRoot: root, dataDir, config })).toEqual({ code: "ok", scopes: [
      { kind: "session-archive", id: "a.1" }, { kind: "session-archive", id: "z" },
    ] });
    expect((await collectEvidenceFiles({ projectRoot: root, dataDir, config: { ...config, maxChunks: 1 } })).code).toBe("budget-exceeded");
    expect(await collectEvidenceFiles({ projectRoot: root, dataDir, config: { ...config, sessionArchives: false } })).toEqual({ code: "ok", scopes: [] });
    await rm(path.join(sessions, "z"), { recursive: true });
    const loaded = await createEvidenceRuntime({ projectRoot: root, dataDir, config, scannerFactory: async () => scanner });
    if (!loaded.ok) throw Error("runtime unavailable");
    try {
      expect((await loaded.runtime.buildConfiguredFiles()).code).toBe("ok");
      const found = await loaded.runtime.searchPublic("archiveneedle", value => value);
      expect(found.code).toBe("ok");
      expect(found.items).toHaveLength(1);
      expect((await loaded.runtime.searchPublic("foreignneedle", value => value)).code).toBe("no-match");
    } finally { loaded.runtime.close(); }
  } finally { await rm(base, { recursive: true, force: true }); }
}, 30000);

test("archive inventory refuses dangling storage roots and symlink parents", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "erl-archive-store-"));
  const projectRoot = path.join(base, "project"), dataDir = path.join(base, "data");
  await mkdir(projectRoot); await mkdir(dataDir);
  const config = { schemaVersion: 1, enabled: true, sessionArchives: true };
  const { collectEvidenceFiles } = await import(moduleName);
  try {
    await symlink(path.join(base, "missing"), path.join(base, "dangling"));
    for (const store of [path.join(base, "dangling"), path.join(base, "dangling/child")]) {
      expect(await collectEvidenceFiles({ projectRoot, dataDir: store, config })).toEqual({ code: "source-unavailable", scopes: [] });
    }
    await symlink(projectRoot, path.join(dataDir, "sessions"));
    expect((await collectEvidenceFiles({ projectRoot, dataDir, config })).code).toBe("source-unavailable");
    await rm(path.join(dataDir, "sessions")); await mkdir(path.join(dataDir, "sessions"));
    const owned = projectSessionsDir(projectRoot, dataDir);
    await symlink(projectRoot, owned);
    expect((await collectEvidenceFiles({ projectRoot, dataDir, config })).code).toBe("source-unavailable");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("runtime captures effective default session store before environment changes", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "erl-archive-env-"));
  const root = path.join(base, "project"), dataDir = path.join(base, "first");
  await mkdir(root);
  const previous = process.env.KERYX_DATA_DIR;
  const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
  try {
    const handle = createSession({ cwd: root, dataDir, id: "fixed" });
    persistHistory(handle, [{ role: "user", content: "fixedstoreneedle" }]);
    process.env.KERYX_DATA_DIR = dataDir;
    const loaded = await createEvidenceRuntime({ projectRoot: root, config: { schemaVersion: 1, enabled: true, sessionArchives: true }, scannerFactory: async () => scanner });
    if (!loaded.ok) throw Error("runtime unavailable");
    try {
      process.env.KERYX_DATA_DIR = path.join(base, "second");
      expect((await loaded.runtime.buildConfiguredFiles()).code).toBe("ok");
      expect((await loaded.runtime.searchPublic("fixedstoreneedle", value => value)).code).toBe("ok");
    } finally { loaded.runtime.close(); }
  } finally {
    if (previous === undefined) delete process.env.KERYX_DATA_DIR; else process.env.KERYX_DATA_DIR = previous;
    await rm(base, { recursive: true, force: true });
  }
}, 30000);

test("archive inventory rejects linked archive files and missing summaries", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "erl-archive-candidate-"));
  const root = path.join(base, "project"), dataDir = path.join(base, "data");
  await mkdir(root);
  const { collectEvidenceFiles } = await import(moduleName);
  const config = { schemaVersion: 1, enabled: true, sessionArchives: true };
  try {
    const handle = createSession({ cwd: root, dataDir, id: "owned" });
    persistHistory(handle, [{ role: "user", content: "candidate" }]);
    const session = path.join(projectSessionsDir(root, dataDir), "owned");
    for (const filename of ["summary.json", "archive.jsonl"]) {
      await rm(path.join(session, filename));
      await symlink(path.join(session, "missing"), path.join(session, filename));
      expect(await collectEvidenceFiles({ projectRoot: root, dataDir, config }))
        .toEqual({ code: "source-unavailable", scopes: [] });
      await rm(path.join(session, filename));
      persistHistory(handle, [{ role: "user", content: "candidate" }]);
    }
    await rm(path.join(session, "summary.json"));
    expect(await collectEvidenceFiles({ projectRoot: root, dataDir, config }))
      .toEqual({ code: "source-unavailable", scopes: [] });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("inventory shares candidate budget between configured files and archives", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "erl-combined-inventory-"));
  const root = path.join(base, "project"), dataDir = path.join(base, "data");
  await mkdir(path.join(root, "docs"), { recursive: true });
  try {
    await writeFile(path.join(root, "docs/a.txt"), "file");
    persistHistory(createSession({ cwd: root, dataDir, id: "owned" }), [{ role: "user", content: "archive" }]);
    const { collectEvidenceFiles } = await import(moduleName);
    expect(await collectEvidenceFiles({ projectRoot: root, dataDir, config: {
      schemaVersion: 1, enabled: true, roots: ["docs"], sessionArchives: true, maxChunks: 1,
    } })).toEqual({ code: "budget-exceeded", scopes: [] });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("file inventory excludes in-checkout session stores without archive opt-in", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "erl-store-exclusion-"));
  const dataDir = path.join(root, "docs/store");
  try {
    await mkdir(path.join(dataDir, "sessions/foreign/session"), { recursive: true });
    await writeFile(path.join(dataDir, "sessions/foreign/session/archive.jsonl"), "opaque replay");
    await writeFile(path.join(root, "docs/note.txt"), "ordinary evidence");
    const { collectEvidenceFiles } = await import(moduleName);
    expect(await collectEvidenceFiles({ projectRoot: root, dataDir,
      config: { schemaVersion: 1, enabled: true, roots: ["docs"], sessionArchives: false } })).toEqual({
      code: "ok", scopes: [{ kind: "file", id: "docs/note.txt" }],
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
