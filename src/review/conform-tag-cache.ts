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

// Clause-tag schema version (precision fix, flow 337): bumped whenever
// TAGGING BEHAVIOUR changes enough that an old cached tag can no longer be
// trusted — here, the deterministic process pre-classifier
// (`./conform-clauses.ts`'s `preClassifyProcessClause`) and the rewritten
// `choice` question wording both change what a clause's tag OUGHT to be,
// even though the document's own bytes are unchanged. Folded into the hash
// fed to `cachedTagsFor`/`writeClauseTagCache` (not into `docPath` or the
// cache file's shape) so a v1 entry simply misses under v2 — the SAME
// "wrong hash reads as nothing cached" fail-closed behaviour a genuine
// content edit already gets, no separate migration path needed.
//
// v3 (clause-tag precision fix, flow 337 follow-up): `isWorkflowListStep`
// now reads only the NEAREST heading (not the whole ancestor chain) and no
// longer treats "fenced" as process on its own; `CODE_PROPERTY_NOUNS` grew
// several property nouns (`file`, `files`, `path`, ...); and a verb-lead
// match now checks what follows it before pre-classifying. All three change
// which clauses `preClassifyProcessClause` drops for the SAME document
// bytes, so a v2-cached tag can no longer be trusted either.
const CLAUSE_TAG_SCHEMA_VERSION = 3;

/**
 * The hash `readClauseTagCache`/`writeClauseTagCache`/`cachedTagsFor` key a
 * clause-tag cache entry by — `hashOriginContent` (the same convention
 * `src/gdskills/project-skills.ts` uses for origin drift) over the doc's own
 * content, PREFIXED with {@link CLAUSE_TAG_SCHEMA_VERSION} so a schema bump
 * changes every hash even when the document itself did not.
 */
export function hashConformDocContent(content: string): string {
  return hashOriginContent(`clause-tag-schema:v${CLAUSE_TAG_SCHEMA_VERSION}\n${content}`);
}

function cacheFilePath(cwd: string, cacheRelPath: string): string {
  return path.join(cwd, cacheRelPath);
}

/**
 * Read the whole cache file. A missing or unparsable file reads as empty —
 * never thrown. `cacheRelPath` defaults to conform's own cache
 * ({@link CONFORM_TAG_CACHE_PATH}); a caller with its own tag cache (flow
 * 330's `review-jev-rules`, `JEV_RULES_TAG_CACHE_PATH` in
 * `./jev-rules-cache.ts`) passes its own path so the two reviewers' caches
 * never collide on disk, while both go through this exact module rather than
 * a copy of its read/write/merge logic.
 */
export async function readClauseTagCache(cwd: string, cacheRelPath: string = CONFORM_TAG_CACHE_PATH): Promise<CacheFile> {
  const file = cacheFilePath(cwd, cacheRelPath);
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

/** Merge a freshly-resolved set of clause tags into the cache for `docPath`/`contentHash`, and persist it. `cacheRelPath` — see {@link readClauseTagCache}. */
export async function writeClauseTagCache(
  cwd: string,
  docPath: string,
  contentHash: string,
  tags: Readonly<Record<string, ClauseTag>>,
  cacheRelPath: string = CONFORM_TAG_CACHE_PATH,
): Promise<void> {
  const current = await readClauseTagCache(cwd, cacheRelPath);
  const existing = cachedTagsFor(current, docPath, contentHash) ?? {};
  const next: CacheFile = { ...current, [docPath]: { contentHash, tags: { ...existing, ...tags } } };
  // 0o600: this file names reference documents and their per-clause tags —
  // other users on the same machine should not be able to read it.
  await writeFileAtomic(cacheFilePath(cwd, cacheRelPath), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
