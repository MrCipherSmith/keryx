import { tokenSet, tokenize } from "./text";
import { memoryClassOf } from "./types";
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
  const queryTokens = [...new Set(tokenize(query))];
  const today = now.toISOString().slice(0, 10);
  const filtered = entries.filter(
    (entry) =>
      matchesFilters(entry, filters) &&
      classMatch(entry, filters.class) &&
      temporalMatch(entry, filters.asOf ?? null, config, today),
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
    .slice(0, filters.limit ?? config.ranking.maxResults);
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
  const queryTokens = [...new Set(tokenize(query))];
  const today = now.toISOString().slice(0, 10);
  return entries
    .filter(
      (entry) =>
        matchesFilters(entry, filters) &&
        classMatch(entry, filters.class) &&
        temporalMatch(entry, filters.asOf ?? null, config, today),
    )
    .map((entry) => scoreEntry(entry, queryTokens, filters, config, now))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, k));
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

// C2 bitemporal filter. Deterministic string/date comparison — no runtime, no
// network. A no-op for entries without validity fields (byte-identical default).
//   as-of <d>: include iff Valid-From ≤ d AND (Valid-To unset OR Valid-To > d).
//   current  : exclude entries with a past Valid-To or any Superseded-By.
function temporalMatch(
  entry: MemoryEntry,
  asOf: string | null,
  config: MemoryConfig,
  today: string,
): boolean {
  if (!config.temporal.enabled) {
    return true;
  }
  if (asOf) {
    const from = entry.validFrom ?? null;
    const to = entry.validTo ?? null;
    if (from && from > asOf) {
      return false; // not yet valid at asOf
    }
    if (to && to <= asOf) {
      return false; // validity interval [from, to) already closed at asOf
    }
    return true;
  }
  // No explicit as-of date. Only the "current" default performs exclusion.
  if (config.temporal.defaultQuery === "as-of") {
    return true;
  }
  if (entry.supersededBy) {
    return false;
  }
  if (entry.validTo && entry.validTo < today) {
    return false;
  }
  return true;
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
              `- type: ${e.type} | status: ${e.status} | confidence: ${e.confidence}`,
              `- ${item.reason}`,
              scopes ? `- scopes: ${scopes}` : "",
              e.provenance.source ? `- provenance: ${e.provenance.source}` : "",
              `- summary: ${e.summary || "(none)"}`,
              `- entry: ${e.relativePath}`,
            ]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n\n");

  return `# Memory search: ${query}

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
