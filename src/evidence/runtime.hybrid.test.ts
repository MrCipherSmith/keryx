import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidenceRuntime } from "./runtime";
import type { EvidenceEmbeddingOptions } from "./embedding-builder";
const scanner = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
test("runtime hybrid discovers semantic-only evidence without query cache writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-runtime-hybrid-"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, ".metaproject"));
  await writeFile(path.join(root, ".metaproject/metaproject.json"), JSON.stringify({
    modules: { evidence: { capabilities: [{ id: "fixture-hybrid", enabled: true }] } },
  }));
  await writeFile(path.join(root, "docs/a.txt"), "orchard apple");
  const calls: string[][] = [], purposes: string[] = [];
  const embedding: EvidenceEmbeddingOptions = {
    projectRoot: root, remote: true,
    identity: { project: root, adapter: "fixture-hybrid", model: "fixture", revision: "1", dimensions: 2, sanitizer: "v1" },
    authorizeRemote: async request => { purposes.push(request.purpose); return true; },
    spec: { id: "fixture-hybrid", load: () => ({ id: "fixture-hybrid", isAvailable: async () => true,
      run: async input => { calls.push([...input.texts]); return input.texts.map(() => [1, 0]); } }) },
  };
  const created = await createEvidenceRuntime({ projectRoot: root,
    config: { schemaVersion: 1, enabled: true, mode: "hybrid", roots: ["docs"] }, embedding, scannerFactory: async () => scanner });
  try {
    expect(created.ok).toBe(true);
    if (!created.ok) throw Error(created.diagnostics.join(","));
    expect((await created.runtime.buildConfiguredFiles()).code).toBe("ok");
    const directory = path.join(root, ".metaproject/evidence");
    const before = (await readdir(directory)).sort();
    const result = await created.runtime.searchPublic("fruit garden", value => value);
    expect(result.code).toBe("ok");
    expect(result.items[0]?.text).toBe("orchard apple");
    expect(result.diagnostics).toEqual([]);
    expect(purposes).toEqual(["corpus", "query"]);
    expect(calls).toEqual([["orchard apple"], ["fruit garden"]]);
    expect((await readdir(directory)).sort()).toEqual(before);
    created.runtime.close();
    for (const change of [{ model: "other" }, { revision: "2" }, { dimensions: 3 }]) {
      const reopened = await createEvidenceRuntime({ projectRoot: root,
        config: { schemaVersion: 1, enabled: true, mode: "hybrid", roots: ["docs"] },
        embedding: { ...embedding, identity: { ...embedding.identity, ...change } },
        scannerFactory: async () => scanner });
      if (!reopened.ok) throw Error(reopened.diagnostics.join(","));
      try {
        const beforeCalls = calls.length;
        const incompatible = await reopened.runtime.searchPublic("apple", value => value);
        expect(incompatible.code).toBe("source-unavailable");
        expect(incompatible.items).toEqual([]);
        expect(incompatible.diagnostics).toEqual(["index-incompatible"]);
        expect(calls.length).toBe(beforeCalls);
        expect((await readdir(directory)).sort()).toEqual(before);
      } finally { reopened.runtime.close(); }
    }
  } finally { if (created.ok) created.runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("runtime hybrid without an embedding adapter falls back without query writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-hybrid-fallback-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs/a.txt"), "orchard apple");
  const created = await createEvidenceRuntime({ projectRoot: root,
    config: { schemaVersion: 1, enabled: true, mode: "hybrid", roots: ["docs"] }, scannerFactory: async () => scanner });
  try {
    expect(created.ok).toBe(true);
    if (!created.ok) throw Error(created.diagnostics.join(","));
    expect((await created.runtime.buildConfiguredFiles()).code).toBe("ok");
    const directory = path.join(root, ".metaproject/evidence");
    const before = (await readdir(directory)).sort();
    const result = await created.runtime.searchPublic("apple", value => value);
    expect(result.code).toBe("ok");
    expect(result.items[0]?.text).toBe("orchard apple");
    expect(result.diagnostics).toEqual(["semantic-fallback"]);
    const miss = await created.runtime.searchPublic("fruit garden", value => value);
    expect(miss.code).toBe("no-match");
    expect(miss.diagnostics).toEqual(["semantic-fallback"]);
    expect((await readdir(directory)).sort()).toEqual(before);
  } finally { if (created.ok) created.runtime.close(); await rm(root, { recursive: true, force: true }); }
});
