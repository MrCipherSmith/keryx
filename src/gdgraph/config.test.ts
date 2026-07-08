import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_GDGRAPH_CONFIG, loadGdgraphConfig, mergeGdgraphConfig } from "./config";

test("AC5.1 — defaults: affected.defaultDepth is 1 (back-compat)", () => {
  expect(DEFAULT_GDGRAPH_CONFIG.affected.defaultDepth).toBe(1);
  expect(mergeGdgraphConfig({}).repomap.tokenBudget).toBe(8000);
  expect(mergeGdgraphConfig({}).repomap.tokenEstimator).toBe("chars-div-4");
});

test("AC5.1 — deep-merge overrides individual fields, keeps the rest", () => {
  const merged = mergeGdgraphConfig({
    affected: { defaultDepth: 3 },
    repomap: { tokenBudget: 100 },
    treesitter: { languages: ["typescript"] },
  });
  expect(merged.affected.defaultDepth).toBe(3);
  expect(merged.repomap.tokenBudget).toBe(100);
  // Untouched fields fall back to defaults.
  expect(merged.repomap.damping).toBe(DEFAULT_GDGRAPH_CONFIG.repomap.damping);
  expect(merged.treesitter.languages).toEqual(["typescript"]);
  expect(merged.treesitter.grammarsPath).toBeNull();
});

test("AC5.1/C0-8 — missing config file ⇒ defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-cfg-"));
  try {
    const config = await loadGdgraphConfig(root);
    expect(config).toEqual(mergeGdgraphConfig({}));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC5.1/C0-8 — malformed JSON ⇒ defaults (never throws)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-cfg-bad-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "gdgraph.config.json"), "{ not valid json ");
    const config = await loadGdgraphConfig(root);
    expect(config).toEqual(mergeGdgraphConfig({}));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
