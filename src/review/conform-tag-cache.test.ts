// Flow 308, AC2: the clause-tag cache — keyed by document content hash, so
// an unchanged document is not re-tagged.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cachedTagsFor, CONFORM_TAG_CACHE_PATH, hashConformDocContent, readClauseTagCache, writeClauseTagCache } from "./conform-tag-cache";

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
});
