// Reference-document conformance mode — flow 308, AC2's cache: "a single Jev
// `choice` question per clause, cached by the document's content hash so an
// unchanged document is not re-tagged."
//
// One JSON file per project, keyed by the document's own path (relative to
// `cwd`, so a cache is portable across a clone) and content hash (reusing
// `hashOriginContent`, the same convention `src/gdskills/project-skills.ts`
// already uses for origin drift). A doc whose content hash no longer matches
// what is cached is treated as uncached for every clause — never partially
// trusted — so a caller always knows whether IT is the one asking Jev again.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { hashOriginContent } from "../gdskills/project-skills";
import type { ClauseTag } from "./conform-clauses";

export const CONFORM_TAG_CACHE_PATH = ".metaproject/data/review-conform/clause-tags.json";

interface CacheFile {
  readonly [docPath: string]: {
    readonly contentHash: string;
    readonly tags: Readonly<Record<string, ClauseTag>>;
  };
}

export { hashOriginContent as hashConformDocContent };

function cacheFilePath(cwd: string): string {
  return path.join(cwd, CONFORM_TAG_CACHE_PATH);
}

/** Read the whole cache file. A missing or unparsable file reads as empty — never thrown. */
export async function readClauseTagCache(cwd: string): Promise<CacheFile> {
  const file = cacheFilePath(cwd);
  if (!(await pathExists(file))) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as CacheFile;
  } catch {
    return {};
  }
}

/**
 * Tags cached for `docPath` at exactly `contentHash` — a stale entry (any
 * other hash) reads as "nothing cached", not as a partial hit.
 */
export function cachedTagsFor(cache: CacheFile, docPath: string, contentHash: string): Readonly<Record<string, ClauseTag>> | undefined {
  const entry = cache[docPath];
  if (entry === undefined || entry.contentHash !== contentHash) return undefined;
  return entry.tags;
}

/** Merge a freshly-resolved set of clause tags into the cache for `docPath`/`contentHash`, and persist it. */
export async function writeClauseTagCache(
  cwd: string,
  docPath: string,
  contentHash: string,
  tags: Readonly<Record<string, ClauseTag>>,
): Promise<void> {
  const current = await readClauseTagCache(cwd);
  const existing = cachedTagsFor(current, docPath, contentHash) ?? {};
  const next: CacheFile = { ...current, [docPath]: { contentHash, tags: { ...existing, ...tags } } };
  // 0o600: this file names reference documents and their per-clause tags —
  // other users on the same machine should not be able to read it.
  await writeFileAtomic(cacheFilePath(cwd), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
