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
import type { ContextOverflow } from "../ctx/assembly";
import { computeAffected } from "./affected";
import type { GdgraphConfig } from "./config";
import { personalizedPageRank, type RankEdge } from "./pagerank";
import type { GraphData, SymbolNode } from "./types";

export interface RepomapEntry {
  path: string;
  score: number;
  symbols: string[];
  // AFC-12: true for a matched seed, or a direct (depth-1) consumer/test of a
  // matched seed. A required entry is protected from budget/rank eviction —
  // it is not merely another ranked candidate the tie-break can outvote.
  required: boolean;
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
  // AFC-12: paths of OPTIONAL (non-required) entries dropped for budget —
  // the visible-loss list, named rather than just counted.
  omittedOptional: string[];
  // True when omittedOptional is non-empty — an optional-entry loss occurred.
  partial: boolean;
  // Present only when the required set (seed + known consumers/tests) does
  // not fit the budget as a whole. Mirrors `src/ctx/assembly.ts`'s
  // `ContextOverflow` vocabulary (required-vs-optional, `context_overflow`,
  // `requiredId`) rather than inventing a second one. When set, `entries` is
  // empty: a truncated required set is never reported as an ordinary success.
  overflow?: ContextOverflow;
}

// Local token estimator — the documented `chars-div-4` default (AC3.2). Kept
// tiny + local since there is no shared gdctx estimator in this repo.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// The stable omission marker (AC3.2). `count` varies; the shape is fixed —
// UNCHANGED from before AFC-12, so the hard token budget and the existing
// pop-until-it-fits loop keep their original, tested convergence behavior
// regardless of how many optional entries are omitted.
function omissionMarker(count: number): string {
  return `\n… ${count} entries omitted …\n`;
}

// AFC-12 visible-loss hint: a SHORT, length-bounded (not proportional to how
// many paths were dropped) pointer to the full `omittedOptional` list on the
// result, plus how to continue. Appended best-effort, only if it still fits
// the budget — it never forces additional entries to be popped. The full,
// unbounded list of dropped optional paths always lives in the structured
// `RepomapResult.omittedOptional` field, never only in this rendered text.
function omissionHint(omittedOptional: readonly string[]): string {
  const noun = omittedOptional.length === 1 ? "entry" : "entries";
  return `${omittedOptional.length} optional ${noun} omitted for budget — see \`omittedOptional\`. Increase --budget or narrow --seed to include them.\n`;
}

// A required entry (seed / known consumer / test) that does not fit the
// budget as a whole (AFC-12): "budget-exceeded, not success with a truncated
// required set." No entries are rendered — a partial required set is never
// presented as legitimate.
function overflowContent(required: readonly RepomapEntry[], missing: RepomapEntry, budget: number): string {
  const requiredList = required.map((entry) => `- ${entry.path}`).join("\n");
  return [
    HEADER.trimEnd(),
    "",
    `context_overflow: required entry "${missing.path}" does not fit within the ${budget}-token budget.`,
    "",
    "Required (seed + known consumers/tests):",
    requiredList,
    "",
    "Increase --budget, or narrow --seed, and retry.",
    "",
  ].join("\n");
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
  const fileNodeSet = new Set(fileNodes);
  const rankEdges = buildRankEdges(graph, config);

  // Resolve seeds to real graph nodes. A seed matching no node is silently
  // dropped from personalization here, unchanged from prior behavior —
  // resolution diagnostics for an unmatched seed are a separate concern.
  const matchedSeeds: string[] = [];
  const personalization = new Map<string, number>();
  for (const seed of options.seed ?? []) {
    const normalized = seed.replace(/^\.\//, "");
    const match = fileNodes.find((file) => file === normalized || file.endsWith(normalized));
    if (match) {
      personalization.set(match, (personalization.get(match) ?? 0) + 1);
      matchedSeeds.push(match);
    }
  }

  // AFC-12 required set: a seed is not merely another ranked candidate — the
  // ranking must not be able to outvote an explicit request. A matched seed,
  // plus every direct (depth-1) dependent the graph already knows about
  // (consumers AND tests alike — a test is simply a file that imports the
  // seed), is protected from budget/rank eviction. Reuses `computeAffected`'s
  // existing reverse-dependent closure rather than re-deriving one.
  const requiredSet = new Set<string>(matchedSeeds);
  for (const seed of matchedSeeds) {
    const affected = computeAffected(graph, seed, { depth: 1 });
    for (const dependent of affected.dependents) {
      if (fileNodeSet.has(dependent)) {
        requiredSet.add(dependent);
      }
    }
  }

  const ranked = personalizedPageRank(fileNodes, rankEdges, {
    damping: config.repomap.damping,
    iterations: config.repomap.iterations,
    tolerance: config.repomap.tolerance,
    ...(personalization.size > 0 ? { personalization } : {}),
  });

  // AFC-12 zero-value ballast: an entry the personalized rank never reached
  // (score exactly 0 — no organic centrality, no path from any seed) carries
  // no information and must not fill the budget. A required entry is kept
  // regardless of its score — required-ness, not score, decides survival,
  // since a genuine consumer/test with no other inbound edges scores 0 too.
  const allEntries: RepomapEntry[] = ranked
    .filter((node) => node.score > 0 || requiredSet.has(node.id))
    .map((node) => ({
      path: node.id,
      score: node.score,
      symbols: topSymbols(graph, node.id, config.repomap.maxSymbolsPerFile),
      required: requiredSet.has(node.id),
    }));

  const requiredEntries = allEntries.filter((entry) => entry.required);
  const optionalEntries = allEntries.filter((entry) => !entry.required);

  let out = HEADER;
  const rendered: RepomapEntry[] = [];

  // Required entries render first, and ALL of them, or none (AFC-12): "if
  // the seed and its required constraints do not fit as a whole,
  // budget-exceeded, not success with a truncated required set."
  for (const entry of requiredEntries) {
    const trial = out + renderEntryBlock(entry);
    if (estimateTokens(trial) <= budget) {
      out = trial;
      rendered.push(entry);
    } else {
      return {
        path: repomapArtifactPath("."),
        content: overflowContent(requiredEntries, entry, budget),
        entries: [],
        tokens: 0,
        omitted: allEntries.length,
        omittedOptional: [],
        partial: false,
        overflow: { code: "context_overflow", requiredId: entry.path },
      };
    }
  }

  // Optional entries fill the remaining budget, greedily in rank order
  // (unchanged semantics for the non-required pool).
  for (const entry of optionalEntries) {
    const trial = out + renderEntryBlock(entry);
    if (estimateTokens(trial) <= budget) {
      out = trial;
      rendered.push(entry);
    } else {
      break;
    }
  }

  const renderedPaths = new Set(rendered.map((entry) => entry.path));
  let omittedOptional = optionalEntries
    .filter((entry) => !renderedPaths.has(entry.path))
    .map((entry) => entry.path);
  let omitted = omittedOptional.length;

  if (omitted > 0) {
    // Ensure the final content (incl. marker) stays within budget; pop only
    // OPTIONAL entries until the marker fits (AC3.2 hard bound, UNCHANGED) —
    // a required entry is never sacrificed to make room for the omission
    // notice.
    while (
      rendered.length > 0 &&
      !rendered[rendered.length - 1]!.required &&
      estimateTokens(out + omissionMarker(omitted)) > budget
    ) {
      const popped = rendered.pop();
      if (popped) {
        out = out.slice(0, out.length - renderEntryBlock(popped).length);
        omittedOptional = [...omittedOptional, popped.path];
        omitted += 1;
      }
    }
    out += omissionMarker(omitted);

    // Best-effort, length-bounded visible-loss hint (AFC-12) — appended only
    // if it still fits; never forces another entry to be popped.
    const withHint = out + omissionHint(omittedOptional);
    if (estimateTokens(withHint) <= budget) {
      out = withHint;
    }
  }

  return {
    path: repomapArtifactPath("."),
    content: out,
    entries: rendered,
    tokens: estimateTokens(out),
    omitted,
    omittedOptional,
    partial: omittedOptional.length > 0,
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
