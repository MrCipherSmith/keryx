// Pure personalized PageRank (specification.md §8.3; T-B6, B-4/B-5/B-7).
//
// Deterministic power-iteration with FIXED params (damping / iterations /
// tolerance) and a total-order tie-break, so a re-run is byte-identical. No dep,
// no network, no vectors/embeddings — a plain weighted graph centrality.
//
// Rank flows ALONG edges `from → to`, so a file imported/called by many
// accumulates rank from its dependents — surfacing the central, widely-depended
// files/symbols first. Dangling nodes (no out-edges) redistribute their mass via
// the personalization vector, conserving total mass every iteration.

export interface RankEdge {
  from: string;
  to: string;
  weight: number;
}

export interface PageRankOptions {
  damping: number;
  iterations: number;
  tolerance: number;
  // Restart distribution: node id → mass. Missing/empty ⇒ uniform over nodes.
  personalization?: Map<string, number>;
}

export interface RankedNode {
  id: string;
  score: number;
}

// Compute personalized PageRank over `nodes` with weighted `edges`. Returns a
// total-ordered ranking (score desc, then id asc) — reproducible for identical
// input + params.
export function personalizedPageRank(
  nodes: string[],
  edges: RankEdge[],
  options: PageRankOptions,
): RankedNode[] {
  const uniqueNodes = [...new Set(nodes)].sort();
  const n = uniqueNodes.length;
  if (n === 0) {
    return [];
  }

  const index = new Map<string, number>();
  uniqueNodes.forEach((id, i) => index.set(id, i));

  // Out-weight totals + adjacency (only edges whose both endpoints are nodes).
  const outWeight = new Array<number>(n).fill(0);
  const incoming: Array<Array<{ src: number; weight: number }>> = Array.from(
    { length: n },
    () => [],
  );
  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const weight = edge.weight > 0 ? edge.weight : 0;
    if (weight === 0) {
      continue;
    }
    outWeight[from] = (outWeight[from] ?? 0) + weight;
    (incoming[to] ??= []).push({ src: from, weight });
  }

  // Personalization / restart vector, normalized. Empty ⇒ uniform.
  const restart = new Array<number>(n).fill(0);
  const personalization = options.personalization;
  let restartTotal = 0;
  if (personalization && personalization.size > 0) {
    for (const [id, mass] of personalization) {
      const i = index.get(id);
      if (i !== undefined && mass > 0) {
        restart[i] = (restart[i] ?? 0) + mass;
        restartTotal += mass;
      }
    }
  }
  if (restartTotal <= 0) {
    for (let i = 0; i < n; i += 1) {
      restart[i] = 1 / n;
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      restart[i] = (restart[i] ?? 0) / restartTotal;
    }
  }

  const damping = options.damping;
  let rank = restart.slice();

  for (let iter = 0; iter < options.iterations; iter += 1) {
    // Mass held by dangling nodes (no out-weight) is redistributed via restart.
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) {
      if ((outWeight[i] ?? 0) === 0) {
        danglingMass += rank[i] ?? 0;
      }
    }

    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let inbound = 0;
      for (const { src, weight } of incoming[i] ?? []) {
        const srcOut = outWeight[src] ?? 0;
        if (srcOut > 0) {
          inbound += ((rank[src] ?? 0) * weight) / srcOut;
        }
      }
      const restartI = restart[i] ?? 0;
      next[i] = (1 - damping) * restartI + damping * (inbound + danglingMass * restartI);
    }

    let delta = 0;
    for (let i = 0; i < n; i += 1) {
      delta += Math.abs((next[i] ?? 0) - (rank[i] ?? 0));
    }
    rank = next;
    if (delta < options.tolerance) {
      break;
    }
  }

  return uniqueNodes
    .map((id, i) => ({ id, score: rank[i] ?? 0 }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
