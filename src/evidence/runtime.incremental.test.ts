import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, persistHistory } from "../session/store";
import { createEvidenceRuntime } from "./runtime";
import { ArchiveCursor } from "./archive-cursor";

for (const mode of ["lexical", "hybrid"] as const) test(`runtime ${mode} incremental and forceFull agree across real archive and file mutations`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-runtime-incremental-"));
  const dataDir = path.join(root, "data");
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs/a.txt"), "file retrieval");
  await mkdir(path.join(root, ".metaproject"));
  await writeFile(path.join(root, ".metaproject/metaproject.json"), JSON.stringify({
    modules: { evidence: { capabilities: [{ id: "fixture-incremental", enabled: true }] } },
  }));
  const embedding: import("./embedding-builder").EvidenceEmbeddingOptions = {
    projectRoot: root, remote: true,
    identity: { project: root, adapter: "fixture-incremental", model: "fixture", revision: "1", dimensions: 2, sanitizer: "v1" },
    authorizeRemote: async () => true,
    spec: { id: "fixture-incremental", load: () => ({ id: "fixture-incremental", isAvailable: async () => true,
      run: async input => input.texts.map(() => [1, 0]) }) },
  };
  const handle = createSession({ cwd: root, dataDir, id: "cursor-fixture" });
  persistHistory(handle, [{ role: "user", content: "archive retrieval π" }]);
  const archivePath = path.join(handle.dir, "archive.jsonl");
  const original = await readFile(archivePath);
  const created = await createEvidenceRuntime({ projectRoot: root, dataDir,
    config: { schemaVersion: 1, enabled: true, mode, roots: ["docs"], sessionArchives: true },
    ...(mode === "hybrid" ? { embedding } : {}),
    scannerFactory: async () => async text => ({ code: "ok", text, redaction: "not-needed" }),
  });
  const reference = await createEvidenceRuntime({ projectRoot: root, dataDir,
    config: { schemaVersion: 1, enabled: true, mode, roots: ["docs"], sessionArchives: true },
    ...(mode === "hybrid" ? { embedding } : {}),
    scannerFactory: async () => async text => ({ code: "ok", text, redaction: "not-needed" }),
  });
  const { spyOn } = await import("bun:test");
  const prepare = spyOn(ArchiveCursor.prototype, "prepare");
  try {
    if (!reference.ok) throw Error(reference.diagnostics.join(","));
    if (!created.ok) throw Error(created.diagnostics.join(","));
    const runtime = created.runtime;
    let files = ["docs/a.txt"], sessions = [handle.summary.id];
    const compare = async () => {
      const scopes = [
        ...files.map(id => ({ kind: "file" as const, id })),
        ...sessions.map(id => ({ kind: "session-archive" as const, id })),
      ];
      prepare.mockClear();
      const incremental = await runtime.build(scopes);
      expect(incremental.code).toBe("ok");
      if (sessions.length) {
        // Both collection and final validation must use the leased cursor.
        expect(prepare.mock.results).toHaveLength(2);
        const final = prepare.mock.results[1]?.value as ReturnType<ArchiveCursor["prepare"]>;
        expect(final.parsedRows).toBe(0);
        expect(final.reusedRows).toBeGreaterThan(0);
      }
      if (!("generation" in incremental)) throw Error("incremental build failed");
      const expected = JSON.parse(await readFile(path.join(root, ".metaproject/evidence", incremental.generation), "utf8"));
      const before = await runtime.searchPublic("retrieval", value => value);
      const full = await reference.runtime.build(scopes, undefined, Infinity, true);
      expect(full.code).toBe("ok");
      if (!("generation" in full)) throw Error("full build failed");
      const actual = JSON.parse(await readFile(path.join(root, ".metaproject/evidence", full.generation), "utf8"));
      expect(actual.chunks).toEqual(expected.chunks);
      expect(actual.vectors).toEqual(expected.vectors);
      expect(actual.validation).toEqual(expected.validation);
      const after = await runtime.searchPublic("retrieval", value => value);
      expect(after.code).toBe(before.code);
      expect(after.items).toEqual(before.items);
    };
    await compare();
    // Append a physical complete row without replacing the source inode.
    await appendFile(archivePath, original);
    await compare();
    // A partial UTF-8 code point must not advance the complete-record cursor.
    const split = original.indexOf(Buffer.from("π")) + 1;
    expect(split).toBeGreaterThan(0);
    await appendFile(archivePath, original.subarray(0, split));
    await compare();
    await appendFile(archivePath, original.subarray(split));
    await compare();
    persistHistory(handle, [{ role: "assistant", content: "rewritten retrieval" }]);
    await compare();
    await rename(path.join(root, "docs/a.txt"), path.join(root, "docs/b.txt"));
    files = ["docs/b.txt"];
    await compare();
    await rm(archivePath); sessions = [];
    await compare();
    await rm(path.join(root, "docs/b.txt")); files = [];
    await compare();
  } finally {
    prepare.mockRestore();
    if (reference.ok) reference.runtime.close();
    if (created.ok) created.runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
