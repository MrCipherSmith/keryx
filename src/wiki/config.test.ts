import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_WIKI_CONFIG, loadWikiConfig, mergeWikiConfig } from "./config";

test("T2 — defaults: rlm.enabled is false (NFR-4 back-compat)", () => {
  expect(DEFAULT_WIKI_CONFIG.rlm.enabled).toBe(false);
  expect(mergeWikiConfig({}).rlm.classify.skipMaxBytes).toBe(256);
  expect(mergeWikiConfig({}).rlm.batch.enabled).toBe(true);
});

test("T2 — deep-merge overrides individual fields, keeps the rest", () => {
  const merged = mergeWikiConfig({
    rlm: {
      enabled: true,
      classify: { deepMinFanIn: 5 },
      deep: { maxToolCalls: 3 },
    },
  });
  expect(merged.rlm.enabled).toBe(true);
  expect(merged.rlm.classify.deepMinFanIn).toBe(5);
  expect(merged.rlm.deep.maxToolCalls).toBe(3);
  // Untouched fields fall back to defaults.
  expect(merged.rlm.classify.skipMaxBytes).toBe(DEFAULT_WIKI_CONFIG.rlm.classify.skipMaxBytes);
  expect(merged.rlm.classify.deepMinPageRank).toBe(DEFAULT_WIKI_CONFIG.rlm.classify.deepMinPageRank);
  expect(merged.rlm.deep.maxRuntimeMs).toBe(DEFAULT_WIKI_CONFIG.rlm.deep.maxRuntimeMs);
  expect(merged.rlm.batch).toEqual(DEFAULT_WIKI_CONFIG.rlm.batch);
});

test("T2 — non-boolean/non-number overrides (e.g. from malformed JSON) are ignored, defaults kept", () => {
  // Simulates what `readJsonFileOr` can hand back at runtime: arbitrary parsed
  // JSON, only asserted (not validated) as `DeepPartial<WikiConfig>`.
  const malformed = JSON.parse('{"rlm":{"enabled":"yes","classify":{"skipMaxBytes":"not-a-number"}}}');
  const merged = mergeWikiConfig(malformed);
  expect(merged.rlm.enabled).toBe(DEFAULT_WIKI_CONFIG.rlm.enabled);
  expect(merged.rlm.classify.skipMaxBytes).toBe(DEFAULT_WIKI_CONFIG.rlm.classify.skipMaxBytes);
});

test("T2/NFR-4 — missing config file ⇒ defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-cfg-"));
  try {
    const config = await loadWikiConfig(root);
    expect(config).toEqual(mergeWikiConfig({}));
    expect(config.rlm.enabled).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T2 — malformed JSON ⇒ defaults (never throws)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-cfg-bad-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "wiki.config.json"), "{ not valid json ");
    const config = await loadWikiConfig(root);
    expect(config).toEqual(mergeWikiConfig({}));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- T10 (review finding #3): non-positive deep.maxToolCalls/maxRuntimeMs ---
// clamp back to the built-in default instead of passing through unchanged —
// `numberOr` alone only rejected non-finite/non-numeric values, so a
// configured `0` or negative number used to reach `deep-enrich.ts` and
// silently disable its timeout (`deadlineMs > 0` guard there).

test("T10 — mergeWikiConfig: non-positive rlm.deep.maxToolCalls/maxRuntimeMs clamp to the built-in default", () => {
  const merged = mergeWikiConfig({ rlm: { deep: { maxToolCalls: 0, maxRuntimeMs: -100 } } });
  expect(merged.rlm.deep.maxToolCalls).toBe(DEFAULT_WIKI_CONFIG.rlm.deep.maxToolCalls);
  expect(merged.rlm.deep.maxRuntimeMs).toBe(DEFAULT_WIKI_CONFIG.rlm.deep.maxRuntimeMs);
});

test("T10 — mergeWikiConfig: a legitimate positive rlm.deep override still passes through unchanged", () => {
  const merged = mergeWikiConfig({ rlm: { deep: { maxToolCalls: 3, maxRuntimeMs: 1_000 } } });
  expect(merged.rlm.deep.maxToolCalls).toBe(3);
  expect(merged.rlm.deep.maxRuntimeMs).toBe(1_000);
});

test("T10 — loadWikiConfig: a wiki.config.json with maxRuntimeMs: 0 on disk clamps to the default, not 0", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-cfg-clamp-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "wiki.config.json"),
      JSON.stringify({ rlm: { deep: { maxToolCalls: 0, maxRuntimeMs: 0 } } }),
    );
    const config = await loadWikiConfig(root);
    expect(config.rlm.deep.maxToolCalls).toBe(DEFAULT_WIKI_CONFIG.rlm.deep.maxToolCalls);
    expect(config.rlm.deep.maxRuntimeMs).toBe(DEFAULT_WIKI_CONFIG.rlm.deep.maxRuntimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T10 — mergeWikiConfig: classify.skipMaxBytes:0 (a deliberate, meaningful override) is NOT clamped away", () => {
  // Unlike `deep.maxToolCalls`/`deep.maxRuntimeMs`, 0 here is a legitimate,
  // load-bearing value ("never classify skip") — confirms the fix was scoped
  // to the two fields that actually gate a safety budget, not applied
  // blanket to every numeric RLM field.
  const merged = mergeWikiConfig({ rlm: { classify: { skipMaxBytes: 0 } } });
  expect(merged.rlm.classify.skipMaxBytes).toBe(0);
});

test("T2 — present config with rlm.enabled: true is honored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-cfg-on-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "wiki.config.json"),
      JSON.stringify({ rlm: { enabled: true } }),
    );
    const config = await loadWikiConfig(root);
    expect(config.rlm.enabled).toBe(true);
    expect(config.rlm.classify).toEqual(DEFAULT_WIKI_CONFIG.rlm.classify);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
