// Pure N-hop transitive `affected` (specification.md §8.2; T-B3, B2).
//
// A BFS over the REVERSE-DEPENDENT relation: an edge `from → to` means `from`
// depends on `to`, so `to`'s dependents are all the `from`s. Given a target we
// walk outward hop-by-hop to `depth`, collecting the exact transitive dependent
// closure. Pure over the in-memory graph — no dep, no network, no I/O (B-3,
// B-4, AC2.5).
//
// **Back-compat invariant (B-3, AC2.2):** at `depth === 1` the `dependents` set
// equals today's `getAffected().dependents` (edges where `kind !== "unresolved"
// && to === target`), and `dependencies` is the unchanged one-hop forward set,
// so the default renderer output is byte-for-byte identical.

import path from "node:path";
import type { GraphData } from "./types";

export interface RankedDependent {
  path: string;
  // BFS distance from the target (1 = direct dependent).
  hop: number;
  // Number of inbound (non-unresolved) import edges — the fan-in centrality.
  fanIn: number;
}

export interface AffectedResult {
  target: string;
  depth: number;
  dependencies: string[];
  dependents: string[];
  // Blast-radius ranking, ordered hop asc → fanIn desc → path asc (AC2.4).
  ranked: RankedDependent[];
}

export interface AffectedOptions {
  depth?: number;
  ranked?: boolean;
}

// Compute the transitive dependent closure to `depth`. Cycle-safe via a visited
// set (AC2.3). Deterministic + sorted across repeated runs.
export function computeAffected(
  graph: GraphData,
  target: string,
  options: AffectedOptions = {},
): AffectedResult {
  const depth = normalizeDepth(options.depth);
  const normalized = normalizeTarget(target);
  const node = graph.nodes.find(
    (item) => item.path === normalized || item.path.endsWith(normalized),
  );
  const resolvedTarget = node?.path ?? normalized;

  // Reverse-dependent adjacency: to → [from, ...] over non-unresolved edges,
  // matching today's `getAffected` dependent relation exactly at hop 1.
  const dependentsOf = new Map<string, string[]>();
  const fanIn = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === "unresolved") {
      continue;
    }
    const bucket = dependentsOf.get(edge.to);
    if (bucket) {
      bucket.push(edge.from);
    } else {
      dependentsOf.set(edge.to, [edge.from]);
    }
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const hopOf = new Map<string, number>();
  let frontier = new Set<string>([resolvedTarget]);

  for (let hop = 1; hop <= depth; hop += 1) {
    const next = new Set<string>();
    for (const current of frontier) {
      for (const dependent of dependentsOf.get(current) ?? []) {
        if (dependent === resolvedTarget || seen.has(dependent)) {
          continue;
        }
        next.add(dependent);
      }
    }
    if (next.size === 0) {
      break;
    }
    for (const dependent of next) {
      seen.add(dependent);
      if (!hopOf.has(dependent)) {
        hopOf.set(dependent, hop);
      }
    }
    frontier = next;
  }

  // Plain lexicographic sort (default `Array#sort`) — MUST match today's
  // `getAffected` ordering exactly so depth-1 stdout stays byte-identical.
  const dependents = [...seen].sort();

  // One-hop forward set (dependencies) — unchanged from today.
  const dependencies = graph.edges
    .filter((edge) => edge.kind !== "unresolved" && edge.from === resolvedTarget)
    .map((edge) => edge.to)
    .sort();

  const ranked: RankedDependent[] = options.ranked
    ? dependents
        .map((dependentPath) => ({
          path: dependentPath,
          hop: hopOf.get(dependentPath) ?? 0,
          fanIn: fanIn.get(dependentPath) ?? 0,
        }))
        .sort(rankOrder)
    : [];

  return { target: resolvedTarget, depth, dependencies, dependents, ranked };
}

// Total, deterministic order: hop asc → fanIn desc → path asc (AC2.4).
function rankOrder(a: RankedDependent, b: RankedDependent): number {
  if (a.hop !== b.hop) {
    return a.hop - b.hop;
  }
  if (a.fanIn !== b.fanIn) {
    return b.fanIn - a.fanIn;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isFinite(depth)) {
    return 1;
  }
  const floored = Math.floor(depth);
  return floored < 1 ? 1 : floored;
}

function normalizeTarget(target: string): string {
  return target.replace(/^\.\//, "").split(path.sep).join("/");
}

// De-duplicated `dedupeDependents` uniqueness guaranteed by the visited set.
