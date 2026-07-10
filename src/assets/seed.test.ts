import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { GRAMMAR_ASSETS, mergeGrammarAssets, seedAssetsLock } from "./seed";

test("AC6 — Java and Python grammars are seeded into a fresh lock", async () => {
  // New projects must receive the Java/Python tree-sitter grammars on init/update.
  for (const id of ["tree-sitter-java", "tree-sitter-python"]) {
    expect(GRAMMAR_ASSETS[id]).toBeDefined();
    expect(GRAMMAR_ASSETS[id]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(GRAMMAR_ASSETS[id]!.size).toBeGreaterThan(0);
  }
  const root = await mkdtemp(path.join(tmpdir(), "keryx-seed-lang-"));
  try {
    const meta = path.join(root, ".metaproject");
    await mkdir(meta, { recursive: true });
    await seedAssetsLock(meta);
    const parsed = JSON.parse(await readFile(path.join(meta, "assets.lock.json"), "utf8"));
    expect(parsed.assets["tree-sitter-java"]).toBeDefined();
    expect(parsed.assets["tree-sitter-python"]).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeGrammarAssets adds all grammars to an empty lock", () => {
  const { lock, changed } = mergeGrammarAssets({});
  expect(changed).toBe(true);
  expect(Object.keys(lock.assets!).sort()).toEqual(Object.keys(GRAMMAR_ASSETS).sort());
  expect(lock.schemaVersion).toBe(1);
});

test("mergeGrammarAssets preserves existing entries and re-pins (no overwrite)", () => {
  const custom = { version: "9.9.9", url: "https://custom", sha256: "deadbeef", size: 1 };
  const existing = {
    schemaVersion: 1,
    assets: {
      "tree-sitter-typescript": custom, // user re-pinned
      "memory-embed-default": { version: "1", url: "x", sha256: "y", size: 2 }, // other asset
    },
  };
  const { lock } = mergeGrammarAssets(existing);
  expect(lock.assets!["tree-sitter-typescript"]).toEqual(custom); // NOT overwritten
  expect(lock.assets!["memory-embed-default"]).toBeDefined(); // preserved
  expect(lock.assets!["tree-sitter-tsx"]).toEqual(GRAMMAR_ASSETS["tree-sitter-tsx"]); // added
});

test("mergeGrammarAssets is a no-op (changed=false) when all grammars present", () => {
  const seeded = mergeGrammarAssets({}).lock;
  const { changed } = mergeGrammarAssets(seeded);
  expect(changed).toBe(false);
});

test("seedAssetsLock writes a valid lock into a fresh metaproject", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-seed-"));
  try {
    const meta = path.join(root, ".metaproject");
    await mkdir(meta, { recursive: true });
    await seedAssetsLock(meta);
    const parsed = JSON.parse(await readFile(path.join(meta, "assets.lock.json"), "utf8"));
    expect(parsed.assets["tree-sitter-typescript"].sha256).toBe(GRAMMAR_ASSETS["tree-sitter-typescript"]?.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seedAssetsLock reseeds a malformed lock without throwing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-seed-"));
  try {
    const meta = path.join(root, ".metaproject");
    await mkdir(meta, { recursive: true });
    await writeFile(path.join(meta, "assets.lock.json"), "{ not json", "utf8");
    await seedAssetsLock(meta);
    const parsed = JSON.parse(await readFile(path.join(meta, "assets.lock.json"), "utf8"));
    expect(Object.keys(parsed.assets)).toContain("tree-sitter-javascript");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
