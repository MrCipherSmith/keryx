// Flow 308, AC2: the clause-tag cache — keyed by document content hash, so
// an unchanged document is not re-tagged.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cachedTagsFor, CONFORM_TAG_CACHE_PATH, hashConformDocContent, readClauseTagCache, writeClauseTagCache } from "./conform-tag-cache";
import { hashOriginContent } from "../gdskills/project-skills";

let dir = "";

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = "";
  }
});

describe("AC2: clause tag cache", () => {
  test("an absent cache file reads as empty, never throws", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const cache = await readClauseTagCache(dir);
    expect(cache).toEqual({});
  });

  test("write then read round-trips the tags for the exact content hash", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const hash = hashConformDocContent("doc content v1");
    await writeClauseTagCache(dir, "docs/ref.md", hash, {
      "h-1": { state_kind: "pr", checkable: true },
    });
    const cache = await readClauseTagCache(dir);
    expect(cachedTagsFor(cache, "docs/ref.md", hash)).toEqual({ "h-1": { state_kind: "pr", checkable: true } });
  });

  test("a stale hash (content changed) reads as nothing cached", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const hashV1 = hashConformDocContent("doc content v1");
    const hashV2 = hashConformDocContent("doc content v2");
    await writeClauseTagCache(dir, "docs/ref.md", hashV1, { "h-1": { state_kind: "pr", checkable: true } });
    const cache = await readClauseTagCache(dir);
    expect(cachedTagsFor(cache, "docs/ref.md", hashV2)).toBeUndefined();
  });

  test("writing again at the same hash merges rather than replaces", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const hash = hashConformDocContent("doc content v1");
    await writeClauseTagCache(dir, "docs/ref.md", hash, { "h-1": { state_kind: "pr", checkable: true } });
    await writeClauseTagCache(dir, "docs/ref.md", hash, { "h-2": { state_kind: "report", checkable: true } });
    const cache = await readClauseTagCache(dir);
    expect(cachedTagsFor(cache, "docs/ref.md", hash)).toEqual({
      "h-1": { state_kind: "pr", checkable: true },
      "h-2": { state_kind: "report", checkable: true },
    });
  });

  test.skipIf(process.platform === "win32")("the cache file is written owner-only (0o600)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const hash = hashConformDocContent("doc content v1");
    await writeClauseTagCache(dir, "docs/ref.md", hash, { "h-1": { state_kind: "pr", checkable: true } });
    const mode = (await stat(path.join(dir, CONFORM_TAG_CACHE_PATH))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("still owner-only after a second write (the read-modify-write path)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const hash = hashConformDocContent("doc content v1");
    await writeClauseTagCache(dir, "docs/ref.md", hash, { "h-1": { state_kind: "pr", checkable: true } });
    await writeClauseTagCache(dir, "docs/ref.md", hash, { "h-2": { state_kind: "report", checkable: true } });
    const mode = (await stat(path.join(dir, CONFORM_TAG_CACHE_PATH))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // review-jev-rules' precision-fix follow-up reuses this exact module for its
  // own clause tags, at a jev-rules-specific path — `cacheRelPath` lets a
  // caller do that WITHOUT colliding with `review conform`'s own cache file.
  test("a caller-supplied cacheRelPath is a fully independent cache from CONFORM_TAG_CACHE_PATH", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const jevRulesPath = ".metaproject/data/review-jev-rules/clause-tags.json";
    const hash = hashConformDocContent("doc content v1");
    await writeClauseTagCache(dir, "rules/x.mdc", hash, { "h-1": { state_kind: "pr", checkable: true } }); // conform's own path (default)
    await writeClauseTagCache(dir, "rules/x.mdc", hash, { "h-1": { state_kind: "hunk", checkable: true } }, jevRulesPath);

    const conformCache = await readClauseTagCache(dir);
    const jevRulesCache = await readClauseTagCache(dir, jevRulesPath);
    expect(cachedTagsFor(conformCache, "rules/x.mdc", hash)).toEqual({ "h-1": { state_kind: "pr", checkable: true } });
    expect(cachedTagsFor(jevRulesCache, "rules/x.mdc", hash)).toEqual({ "h-1": { state_kind: "hunk", checkable: true } });
    // Two files on disk, not one shared file.
    expect((await stat(path.join(dir, CONFORM_TAG_CACHE_PATH))).isFile()).toBe(true);
    expect((await stat(path.join(dir, jevRulesPath))).isFile()).toBe(true);
  });

  // Precision fix, flow 337 (AC5): a bumped tag-schema version folds into the
  // hash so a cache entry written before the pre-classifier/sharper `choice`
  // wording shipped is never read as a hit afterward — same document bytes,
  // different tagging behaviour, so the cache must miss and re-tag.
  test("the schema version is folded into the hash — a raw hashOriginContent value is a different (stale-schema) key", () => {
    const content = "doc content v1";
    expect(hashConformDocContent(content)).not.toBe(hashOriginContent(content));
  });

  test("a v1-schema hash (simulated: raw hashOriginContent, no version prefix) misses against the current schema's cache entry", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-conform-cache-"));
    const content = "doc content v1";
    const currentHash = hashConformDocContent(content);
    const staleV1Hash = hashOriginContent(content); // what a pre-bump cache would have stored
    await writeClauseTagCache(dir, "docs/ref.md", currentHash, { "h-1": { state_kind: "pr", checkable: true } });
    const cache = await readClauseTagCache(dir);
    expect(cachedTagsFor(cache, "docs/ref.md", staleV1Hash)).toBeUndefined();
    expect(cachedTagsFor(cache, "docs/ref.md", currentHash)).toEqual({ "h-1": { state_kind: "pr", checkable: true } });
  });
});
