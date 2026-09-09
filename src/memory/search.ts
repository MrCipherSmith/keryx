import { tokenSet, tokenize } from "./text";
import { memoryClassOf } from "./types";
import { computeLifecycle } from "./lifecycle";
import { isValidAt, validateAsOf } from "./temporal";
import { validateQuery, validateSearchFilters, MAX_GENERAL_RESULTS } from "./validation";
import type {
  MemoryClass,
  MemoryConfig,
  MemoryEntry,
  ScoredEntry,
  SearchFilters,
} from "./types";

export function searchEntries(
  entries: MemoryEntry[],
  query: string,
  filters: SearchFilters,
  config: MemoryConfig,
  now: Date,
): ScoredEntry[] {
  validateQuery(query);
  validateSearchFilters(filters, now);
  const queryTokens = [...new Set(tokenize(query))];
  const today = now.toISOString().slice(0, 10);
  const filtered = entries.filter(
    (entry) =>
      matchesFilters(entry, filters) &&
      classMatch(entry, filters.class) &&
      temporalMatch(entry, filters.asOf ?? null, config, today, Boolean(filters.status)),
  );

  const scored = filtered.map((entry) =>
    scoreEntry(entry, queryTokens, filters, config, now),
  );

  return scored
    .filter(
      (item) =>
        item.components.relevance > 0 ||
        item.components.scope > 0 ||
        queryTokens.length === 0,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(MAX_GENERAL_RESULTS, filters.limit ?? config.ranking.maxResults));
}

// C1 rerank candidate pool: the top-k entries by deterministic lexical score,
// applying the SAME status/module/entity/class/temporal filters as `searchEntries`
// but WITHOUT the `relevance > 0` drop. This gives the embedding reranker a pool
// that includes semantically-relevant entries lexical scoring would rank low,
// while never introducing entries absent from Markdown. Used only on the opt-in
// semantic path; the default path is unaffected.
export function candidatePool(
  entries: MemoryEntry[],
  query: string,
  filters: SearchFilters,
  config: MemoryConfig,
  now: Date,
  k: number,
): ScoredEntry[] {
  validateQuery(query);
  validateSearchFilters(filters, now);
  const queryTokens = [...new Set(tokenize(query))];
  const today = now.toISOString().slice(0, 10);
  return entries
    .filter(
      (entry) =>
        matchesFilters(entry, filters) &&
        classMatch(entry, filters.class) &&
        temporalMatch(entry, filters.asOf ?? null, config, today, Boolean(filters.status)),
    )
    .map((entry) => scoreEntry(entry, queryTokens, filters, config, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(MAX_GENERAL_RESULTS, Math.max(0, k)));
}

function matchesFilters(entry: MemoryEntry, filters: SearchFilters): boolean {
  if (filters.status && entry.status !== filters.status) {
    return false;
  }
  if (filters.module) {
    const module = filters.module.toLowerCase();
    const moduleMatches =
      entry.scopes.module?.toLowerCase() === module ||
      entry.tags.map((tag) => tag.toLowerCase()).includes(module);
    if (!moduleMatches) {
      return false;
    }
  }
  if (filters.entity && entry.scopes.entity !== filters.entity) {
    return false;
  }
  return true;
}

// C5: restrict to a single knowledge class. No filter ⇒ pass. Resolution uses
// the entry's explicit class or the class mapped from its type (always total).
function classMatch(entry: MemoryEntry, cls: MemoryClass | undefined): boolean {
  if (!cls) {
    return true;
  }
  return memoryClassOf(entry) === cls;
}

// C2 bitemporal filter. All interval semantics live in temporal.ts so general
// search, relevant recall, and procedural injection cannot drift apart.
//
// AFC-06 (flow 234) AC1: the default-current branch below used to admit any
// status as long as the validity interval and supersededBy checks passed, so
// a plain default search (no explicit `--status`) could return a deprecated
// entry as current. It now delegates to the shared `computeLifecycle`
// formula, which also requires `status === "accepted"`. An explicit
// `hasStatusFilter` (the caller supplied `filters.status`, enforced
// separately in `matchesFilters`) is a deliberate override of that
// requirement and keeps the prior interval-only behavior.
//
// T20 finding 1 (flow 234 review, BLOCKER): `acceptedCurrentSearchFilters`
// (relevant.ts) always sets BOTH `status: "accepted"` and
// `asOf: currentDay(now)`. Before this fix, a truthy `asOf` short-circuited
// straight to `isValidAt` below, before either `hasStatusFilter` or the
// lifecycle branch was ever reached -- so an `accepted`-status entry with a
// broken or dangling `Superseded-By` pointer sailed through as "current" on
// that path, even though the exact same entry was correctly rejected by
// `keryx memory search`/`keryx wiki ask` (which normally hit the no-`asOf`
// branches). `flow init`'s "Related Memory" section is built via
// `acceptedCurrentSearchFilters`, so it handed the stale entry to a model as
// authoritative.
//
// Fixed with an unconditional guard, ahead of both branches: an entry whose
// OWN status still literally reads `"accepted"` is never temporally valid
// while it also carries a `supersededBy` pointer. `supersedeEntry`
// (`supersede.ts`) always flips `Status` to `"superseded"` in the SAME write
// that sets `Superseded-By` -- `accepted` + a live `supersededBy` pointer is
// not a normal state the system ever produces; it is exactly the broken/
// dangling-chain anomaly this finding targets. Scoping the guard to
// `entry.status === "accepted"` (rather than to `hasStatusFilter`/`asOf`)
// means it does NOT touch a properly-modeled `superseded`-status entry:
// - an explicit `--status superseded` query still returns the literal
//   superseded entries it asked for (their own status already says so);
// - a bare `asOf` historical query (no status filter) still finds a
//   properly-superseded entry that was valid on that past date, through
//   plain `isValidAt` below, unaffected by this guard.
function temporalMatch(
  entry: MemoryEntry,
  asOf: string | null,
  config: MemoryConfig,
  today: string,
  hasStatusFilter: boolean,
): boolean {
  if (!config.temporal.enabled) {
    return true;
  }
  if (entry.status === "accepted" && entry.supersededBy) {
    return false;
  }
  if (asOf) {
    validateAsOf(asOf, new Date(`${today}T00:00:00.000Z`));
    return isValidAt(entry, asOf);
  }
  // No explicit as-of date. Only the "current" default performs exclusion.
  if (config.temporal.defaultQuery === "as-of") {
    return true;
  }
  if (hasStatusFilter) {
    return isValidAt(entry, today) && !entry.supersededBy;
  }
  return computeLifecycle(
    {
      status: entry.status,
      validFrom: entry.validFrom ?? null,
      validTo: entry.validTo ?? null,
      supersededBy: entry.supersededBy ?? null,
    },
    new Date(`${today}T00:00:00.000Z`),
  ).current;
}

function scoreEntry(
  entry: MemoryEntry,
  queryTokens: string[],
  filters: SearchFilters,
  config: MemoryConfig,
  now: Date,
): ScoredEntry {
  const bodyTokens = tokenSet(
    `${entry.title} ${entry.summary} ${entry.details} ${entry.tags.join(" ")}`,
  );
  const titleTokens = tokenSet(entry.title);

  let hits = 0;
  let titleHits = 0;
  for (const token of queryTokens) {
    if (bodyTokens.has(token)) hits += 1;
    if (titleTokens.has(token)) titleHits += 1;
  }
  const relevance =
    queryTokens.length === 0
      ? 0
      : clamp01((hits + titleHits * 0.5) / queryTokens.length);

  const recency = recencyScore(entry.updated, config, now);
  const confidence = config.confidence.values[entry.confidence] ?? 0.67;
  const status = config.statusBoost[entry.status] ?? 0.4;
  const scope = scopeMatch(entry, filters);

  const w = config.ranking.weights;
  const score =
    w.relevance * relevance +
    w.recency * recency +
    w.confidence * confidence +
    w.status * status +
    w.scope * scope;

  return {
    entry,
    score: round(score),
    components: {
      relevance: round(relevance),
      recency: round(recency),
      confidence: round(confidence),
      status: round(status),
      scope: round(scope),
    },
    reason: `matched ${hits}/${queryTokens.length} terms; status ${entry.status}; confidence ${entry.confidence}`,
  };
}

function recencyScore(
  updated: string | null,
  config: MemoryConfig,
  now: Date,
): number {
  if (!updated) {
    return 0.5;
  }
  const time = Date.parse(updated);
  if (Number.isNaN(time)) {
    return 0.5;
  }
  const days = Math.max(0, (now.getTime() - time) / 86_400_000);
  return clamp01(config.ranking.recencyDecayPerDay ** days);
}

function scopeMatch(entry: MemoryEntry, filters: SearchFilters): number {
  const checks: number[] = [];
  if (filters.module) {
    checks.push(
      entry.scopes.module === filters.module
        ? 1
        : entry.tags.map((t) => t.toLowerCase()).includes(filters.module.toLowerCase())
          ? 0.5
          : 0,
    );
  }
  if (filters.entity) {
    checks.push(entry.scopes.entity === filters.entity ? 1 : 0);
  }
  if (checks.length === 0) {
    return 0;
  }
  return checks.reduce((a, b) => a + b, 0) / checks.length;
}

export function renderSearchMarkdown(
  query: string,
  results: ScoredEntry[],
): string {
  const body =
    results.length === 0
      ? "_No matching memory entries._"
      : results
          .map((item, index) => {
            const e = item.entry;
            const scopes = [
              e.scopes.module ? `module:${e.scopes.module}` : null,
              e.scopes.entity ? `entity:${e.scopes.entity}` : null,
            ]
              .filter(Boolean)
              .join(", ");
            return [
              `### ${index + 1}. ${e.title}  (score ${item.score})`,
              `- type: ${e.type} | status: ${e.status} | confidence: ${e.confidence} | version: ${e.version ?? "unknown"}`,
              `- ${item.reason}`,
              scopes ? `- scopes: ${scopes}` : "",
              // AFC-25 / AC6 (flow 234): always show provenance, author and
              // confirming participant -- an absent value is the explicit
              // "unknown" sentinel, never a silently-dropped line a reader
              // could mistake for "nothing to report".
              `- provenance: ${e.provenance.source ?? "unknown"}${e.provenance.link ? ` (${e.provenance.link})` : ""} | author: ${e.author ?? "unknown"} | confirmedBy: ${e.confirmedBy ?? "unknown"}`,
              e.caveat ? `- caveat: ${e.caveat}` : "",
              `- summary: ${e.summary || "(none)"}`,
              `- entry: ${e.relativePath}`,
            ]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n\n");

  // Lower-case, matching the committed contract this command already had
  // (`memory-p0.test.ts` P0-4) and the sibling report renderer's own
  // `# memory search report:`. Routing the command through this shared
  // renderer must not quietly restyle output the command already promised.
  return `# memory search: ${query}

Results: ${results.length}

${body}
`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
