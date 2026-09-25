// review-jev-rules — flow 330, AC6: "no cache or output file stores keys;
// results cache under `.metaproject/data/` is gitignored, mode 0600."
//
// One JSON file per project, keyed by a content hash of the exact redacted
// state+question text a Jev call would send (see `cacheKeyFor` below) so a
// re-run over the SAME hunk and SAME clause text never re-asks Jev. A key
// mismatch — the hunk moved, the clause text changed, the rule was edited —
// reads as "nothing cached" for that pair, never as a partial or stale hit.
// Mirrors `src/review/conform-tag-cache.ts`'s shape exactly (same project,
// same flow family, same reasoning); that file is not imported because it is
// typed for clause TAGS, not violation probabilities.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";

export const JEV_RULES_CACHE_PATH = ".metaproject/data/review-jev-rules/violation-cache.json";

/**
 * The clause-tag cache location for `review-jev-rules`'s own reuse of
 * `./conform-tag-cache.ts` (precision-fix follow-up to flow 330's original
 * AC1-AC10): a jev-rules-specific file under the same gitignored
 * `.metaproject/data/review-jev-rules/` directory as the violation cache
 * above, rather than sharing conform's `review-conform/clause-tags.json` —
 * so a `review conform` run and a `review-jev-rules` run never race on the
 * same file, while both read/write through the exact same cache module
 * (`readClauseTagCache`/`writeClauseTagCache`, parameterised by this path).
 */
export const JEV_RULES_TAG_CACHE_PATH = ".metaproject/data/review-jev-rules/clause-tags.json";

interface CacheFile {
  readonly [key: string]: { readonly probability: number };
}

/** FNV-1a 32-bit hex — deterministic, dependency-free; a cache key only needs to be stable and collision-unlikely. */
export function hashCacheKey(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The cache key for one (ruleId, clauseId, region) pair — the clause's own text plus the hunk's location, so an edited clause or a moved hunk misses rather than reusing a stale verdict. */
export function cacheKeyFor(ruleId: string, clauseId: string, regionPath: string, regionStartLine: number, regionEndLine: number, clauseText: string): string {
  return hashCacheKey(`${ruleId}::${clauseId}::${regionPath}:${regionStartLine}-${regionEndLine}::${clauseText}`);
}

function cacheFilePath(cwd: string): string {
  return path.join(cwd, JEV_RULES_CACHE_PATH);
}

/** Read the whole cache file. A missing or unparsable file reads as empty — never thrown. */
export async function readJevRulesCache(cwd: string): Promise<CacheFile> {
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

export function cachedProbability(cache: CacheFile, key: string): number | undefined {
  return cache[key]?.probability;
}

/** Merge freshly-scored probabilities into the cache and persist it, 0o600. */
export async function writeJevRulesCache(cwd: string, entries: ReadonlyMap<string, number>): Promise<void> {
  if (entries.size === 0) return;
  const current = await readJevRulesCache(cwd);
  const next: Record<string, { probability: number }> = { ...current };
  for (const [key, probability] of entries) next[key] = { probability };
  // 0o600: this file names hashed hunk/clause pairs and Jev's judgement on
  // them — a redacted-but-still-content-derived cache, not for other users
  // on the same machine to read.
  await writeFileAtomic(cacheFilePath(cwd), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}
