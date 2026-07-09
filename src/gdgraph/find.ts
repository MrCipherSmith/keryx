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

const STOP = new Set([
  "and", "the", "of", "to", "a", "an", "in", "for", "or", "with", "on", "is", "at", "by",
]);

export function findNodes(graph: GraphData, query: string, limit = 20): FindResult[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOP.has(t)),
    ),
  ];
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
