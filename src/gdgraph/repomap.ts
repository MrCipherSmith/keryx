// Ranked, token-budgeted repo map (specification.md §8.3; T-B7, B-4/C0-8).
//
// Ranks files (or symbols, when the layer is present) via personalized PageRank
// and renders `path + top symbols + signatures` into
// `.metaproject/data/gdgraph/artifacts/repomap.md`, enforcing a hard token
// budget. Overflow entries are dropped in rank order with a stable
// "… N entries omitted …" marker. The token estimator mirrors gdctx's byte
// budget idiom (default `chars-div-4`). Deterministic: a re-run diff is empty.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GdgraphConfig } from "./config";
import { personalizedPageRank, type RankEdge } from "./pagerank";
import type { GraphData, SymbolNode } from "./types";

export interface RepomapEntry {
  path: string;
  score: number;
  symbols: string[];
}

export interface RepomapOptions {
  budget?: number;
  seed?: string[];
}

export interface RepomapResult {
  path: string;
  content: string;
  entries: RepomapEntry[];
  tokens: number;
  omitted: number;
}

// Local token estimator — the documented `chars-div-4` default (AC3.2). Kept
// tiny + local since there is no shared gdctx estimator in this repo.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// The stable omission marker (AC3.2). `count` varies; the shape is fixed.
function omissionMarker(count: number): string {
  return `\n… ${count} entries omitted …\n`;
}

function repomapArtifactPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "gdgraph", "artifacts", "repomap.md");
}

// Build the weighted rank edges from the graph: import edges w=1.0, and — when
// the symbol layer is present — CALL edges w=callWeight and `defines` w=0.5.
export function buildRankEdges(graph: GraphData, config: GdgraphConfig): RankEdge[] {
  const edges: RankEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.kind === "imports") {
      edges.push({ from: edge.from, to: edge.to, weight: 1.0 });
    }
  }
  for (const call of graph.calls ?? []) {
    if (call.kind === "calls") {
      edges.push({ from: call.from, to: call.to, weight: config.repomap.callWeight });
    } else if (call.kind === "defines") {
      edges.push({ from: call.from, to: call.to, weight: 0.5 });
    }
  }
  return edges;
}

function renderSymbol(symbol: SymbolNode): string {
  if (symbol.signature && symbol.signature.length > 0) {
    return symbol.signature;
  }
  const container = symbol.container ? `${symbol.container}.` : "";
  return `${symbol.kind} ${container}${symbol.name}`;
}

function topSymbols(graph: GraphData, filePath: string, max: number): string[] {
  const symbols = (graph.symbols ?? [])
    .filter((symbol) => symbol.path === filePath)
    .sort((a, b) =>
      a.startLine !== b.startLine
        ? a.startLine - b.startLine
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0,
    )
    .slice(0, max);
  return symbols.map(renderSymbol);
}

function renderEntryBlock(entry: RepomapEntry): string {
  const lines = [`## ${entry.path}`];
  for (const symbol of entry.symbols) {
    lines.push(`- ${symbol}`);
  }
  return `${lines.join("\n")}\n\n`;
}

const HEADER = [
  "# gdgraph Repomap",
  "",
  "Ranked by personalized PageRank over the import/call graph.",
  "",
  "",
].join("\n");

// Compute the ranked, budget-fitted repomap. Pure over the in-memory graph +
// config; no I/O. `writeRepomap` persists the result.
export function computeRepomap(
  graph: GraphData,
  config: GdgraphConfig,
  options: RepomapOptions = {},
): RepomapResult {
  const budget = options.budget ?? config.repomap.tokenBudget;

  // Rank file nodes (the stable, always-present layer).
  const fileNodes = graph.nodes.filter((node) => node.kind === "file").map((node) => node.path);
  const rankEdges = buildRankEdges(graph, config);

  const personalization = new Map<string, number>();
  for (const seed of options.seed ?? []) {
    const normalized = seed.replace(/^\.\//, "");
    const match = fileNodes.find((file) => file === normalized || file.endsWith(normalized));
    if (match) {
      personalization.set(match, (personalization.get(match) ?? 0) + 1);
    }
  }

  const ranked = personalizedPageRank(fileNodes, rankEdges, {
    damping: config.repomap.damping,
    iterations: config.repomap.iterations,
    tolerance: config.repomap.tolerance,
    ...(personalization.size > 0 ? { personalization } : {}),
  });

  const allEntries: RepomapEntry[] = ranked.map((node) => ({
    path: node.id,
    score: node.score,
    symbols: topSymbols(graph, node.id, config.repomap.maxSymbolsPerFile),
  }));

  // Greedily fill within the budget, always leaving room for the marker.
  let out = HEADER;
  const rendered: RepomapEntry[] = [];
  for (const entry of allEntries) {
    const trial = out + renderEntryBlock(entry);
    if (estimateTokens(trial) <= budget) {
      out = trial;
      rendered.push(entry);
    } else {
      break;
    }
  }

  let omitted = allEntries.length - rendered.length;
  if (omitted > 0) {
    // Ensure the final content (incl. marker) stays within budget; pop entries
    // until the marker fits (AC3.2 hard bound).
    while (rendered.length > 0 && estimateTokens(out + omissionMarker(omitted)) > budget) {
      const popped = rendered.pop();
      if (popped) {
        out = out.slice(0, out.length - renderEntryBlock(popped).length);
        omitted += 1;
      }
    }
    out += omissionMarker(omitted);
  }

  return {
    path: repomapArtifactPath("."),
    content: out,
    entries: rendered,
    tokens: estimateTokens(out),
    omitted,
  };
}

// Compute + persist `artifacts/repomap.md`. Re-running yields a byte-identical
// file (deterministic ranking + rendering).
export async function writeRepomap(
  cwd: string,
  graph: GraphData,
  config: GdgraphConfig,
  options: RepomapOptions = {},
): Promise<RepomapResult> {
  const result = computeRepomap(graph, config, options);
  const artifactPath = repomapArtifactPath(cwd);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, result.content, "utf8");
  return { ...result, path: artifactPath };
}
