import type { GraphData } from "./types";

// Seed-file search over the file-level graph — the "find files about X" primitive
// keryx lacked (agents kept mis-reaching for `gdgraph query "<nl>"`, which only
// does cycles/orphans). Deterministic and offline: rank file nodes by how many
// query terms match their path, with a basename boost, tie-broken by fan-in
// (dependents) as an importance proxy. The result is a short seed list to feed
// into `gdgraph affected <file>`.

export interface FindResult {
  path: string;
  score: number;
  matched: string[];
  dependents: number;
}

export interface SymbolFindResult {
  id: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  score: number;
  matched: string[];
}

const STOP = new Set([
  "and", "the", "of", "to", "a", "an", "in", "for", "or", "with", "on", "is", "at", "by",
]);

// Split a free-text query into distinct, meaningful search terms.
export function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOP.has(t)),
    ),
  ];
}

// Rank symbol nodes by name match — the precise half of `find` when the symbol
// layer is active. Exact name match is boosted so `find "clonePipeline"` returns
// the definition, not just path hits.
export function findSymbols(graph: GraphData, query: string, limit = 15): SymbolFindResult[] {
  const terms = tokenize(query);
  const symbols = graph.symbols ?? [];
  if (terms.length === 0 || symbols.length === 0) {
    return [];
  }

  const results: SymbolFindResult[] = [];
  for (const symbol of symbols) {
    const nameLower = symbol.name.toLowerCase();
    const matched = terms.filter((t) => nameLower.includes(t));
    if (matched.length === 0) {
      continue;
    }
    const exactBonus = terms.some((t) => nameLower === t) ? 20 : 0;
    results.push({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      path: symbol.path,
      startLine: symbol.startLine,
      score: matched.length * 10 + exactBonus,
      matched,
    });
  }
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return results.slice(0, limit);
}

export function findNodes(graph: GraphData, query: string, limit = 20): FindResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }

  // fan-in (dependents) per node id: how many edges point at it.
  const fanIn = new Map<string, number>();
  for (const edge of graph.edges) {
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }

  const results: FindResult[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "file") {
      continue;
    }
    const lowerPath = node.path.toLowerCase();
    const base = lowerPath.split("/").pop() ?? lowerPath;
    const matched = terms.filter((t) => lowerPath.includes(t));
    if (matched.length === 0) {
      continue;
    }
    const baseHits = matched.filter((t) => base.includes(t)).length;
    const score = matched.length * 10 + baseHits * 5;
    results.push({ path: node.path, score, matched, dependents: fanIn.get(node.id) ?? 0 });
  }

  results.sort(
    (a, b) => b.score - a.score || b.dependents - a.dependents || a.path.localeCompare(b.path),
  );
  return results.slice(0, limit);
}
