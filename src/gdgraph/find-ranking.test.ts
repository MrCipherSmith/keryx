// AC6 (AFC-M04, flow 235): "важный связанный код не уступает нерелевантной
// глобальной популярности" — and AC5's `no-match` / `insufficient-evidence` /
// `index-incomplete` / `invalid-input` separation on the description-only
// surface.
//
// WHY THIS FIXTURE IS SHAPED THE WAY IT IS
//
// A ranking claim is only tested by a corpus where a PLAUSIBLE-BUT-WRONG
// ranking is visibly wrong. The measured defect (flow 235 inventory, confirmed
// again here on 2026-09-08 against the live index) was:
//
//   keryx gdgraph find "wiki search ranking by section"
//     → 16 files tied at score 15, led by src/memory/search.ts (dependents 12);
//       src/wiki/ask.ts — the one file the query is actually about — scored 10
//       and fell below the 20-item cut entirely.
//
// The cause is not "fan-in is used". It is that EVERY matched term counted the
// same, so a hit on `search` (in nearly every path in this repo, and therefore
// carrying no information) outscored a hit on `wiki` (in a handful), and global
// popularity then decided the resulting mass tie.
//
// So the corpus below makes `search` corpus-wide and `wiki`/`ranking` rare, and
// hands the biggest fan-in in the graph to a file that matches ONLY the
// corpus-wide term. Four plausible-but-wrong rankings each fail it:
//
//   - fan-in first                  → search-registry.ts wins            ✗
//   - matched-term COUNT first      → all single-term matchers tie,
//                                     fan-in decides → search-registry  ✗
//   - count + basename boost (the shipped ranking) → memory/search.ts
//                                     and search-registry outrank ask.ts ✗
//   - fan-in ADDED to the score rather than breaking a tie
//                                   → search-registry (fanIn 400) wins  ✗
//
// Only a ranking that weights a term by how much it actually discriminates,
// and keeps fan-in as a tie-break, puts the right files on top.

import { expect, test } from "bun:test";
import { findCandidates, findNodes } from "./find";
import type { GraphData, GraphNode, GraphEdge } from "./types";

function fileNode(path: string): GraphNode {
  return { id: path, kind: "file", path, language: "typescript" };
}

function edgesInto(target: string, count: number, tag: string): GraphEdge[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${tag}${i}->${target}`,
    from: `src/callers/${tag}-${i}.ts`,
    to: target,
    kind: "imports" as const,
    specifier: target,
  }));
}

const ASK = "src/wiki/ask.ts";
const WIKI_INDEX = "src/wiki/loader.ts";
const SECTION_RANKING = "src/index/section-ranking.ts";
const MEMORY_SEARCH = "src/memory/search.ts";
// The irrelevant global celebrity: matches only the corpus-wide term, and is
// the most-depended-on file in the whole graph.
const POPULAR = "src/core/search-registry.ts";

function buildCorpus(): GraphData {
  const nodes: GraphNode[] = [
    fileNode(ASK),
    fileNode(WIKI_INDEX),
    fileNode(SECTION_RANKING),
    fileNode(MEMORY_SEARCH),
    fileNode(POPULAR),
  ];
  // 55 filler files that all carry "search" in their path, making it a term
  // with no discriminating power in this corpus.
  for (let i = 0; i < 55; i += 1) {
    nodes.push(fileNode(`src/mod${i}/search-helper-${i}.ts`));
  }
  const edges: GraphEdge[] = [
    ...edgesInto(POPULAR, 400, "pop"),
    ...edgesInto(MEMORY_SEARCH, 12, "mem"),
  ];
  // The caller nodes themselves are not file nodes in this corpus on purpose:
  // fan-in must be readable from the edge list alone, exactly as `findNodes`
  // reads it in production.
  return { nodes, edges };
}

const CORPUS = buildCorpus();
const QUERY = "wiki search ranking";

test("the discriminating term wins: the rare-term match ranks first", () => {
  const results = findNodes(CORPUS, QUERY);
  expect(results[0]?.path).toBe(SECTION_RANKING);
});

test("important related code is not crowded out by corpus-wide term hits", () => {
  const results = findNodes(CORPUS, QUERY);
  const paths = results.map((r) => r.path);
  // The measured defect verbatim: ask.ts fell off the end of the list.
  expect(paths.slice(0, 3)).toContain(ASK);
});

test("important related code does not lose to irrelevant global popularity", () => {
  const results = findNodes(CORPUS, QUERY);
  const paths = results.map((r) => r.path);
  const askRank = paths.indexOf(ASK);
  const popularRank = paths.indexOf(POPULAR);
  const memoryRank = paths.indexOf(MEMORY_SEARCH);

  expect(askRank).toBeGreaterThanOrEqual(0);
  // 400 dependents and 12 dependents both lose to a hit on a term that
  // actually narrows the corpus.
  expect(askRank).toBeLessThan(popularRank);
  expect(askRank).toBeLessThan(memoryRank);
});

test("fan-in still breaks a tie between two equally discriminating matches", () => {
  // The fix must not throw fan-in away — it must demote it to a tie-break.
  // POPULAR and MEMORY_SEARCH match the identical single corpus-wide term with
  // an identical basename hit, so nothing but fan-in separates them.
  const results = findNodes(CORPUS, QUERY);
  const paths = results.map((r) => r.path);
  expect(paths.indexOf(POPULAR)).toBeLessThan(paths.indexOf(MEMORY_SEARCH));
});

test("a corpus-wide term contributes no ballast score of its own", () => {
  // specification.md §5: "Zero-score не добавляет ballast". A term present in
  // EVERY file distinguishes nothing, so a file whose only hit is that term is
  // not a candidate at all — and dropping it must not stop the scan of the
  // remaining files.
  const nodes = [fileNode("src/real-target.ts")];
  for (let i = 0; i < 19; i += 1) {
    nodes.push(fileNode(`src/filler-${i}.ts`));
  }
  const ubiquitous: GraphData = { nodes, edges: [] };
  // "src" is in all 20 paths — zero weight. "target" is in one.
  const results = findNodes(ubiquitous, "src target");
  expect(results.map((r) => r.path)).toEqual(["src/real-target.ts"]);
});

test("every candidate carries the reason it was chosen", () => {
  const results = findNodes(CORPUS, QUERY);
  for (const result of results) {
    expect(result.matched.length).toBeGreaterThan(0);
    expect(result.reason).toContain("matched");
    for (const term of result.matched) {
      expect(result.reason).toContain(term);
    }
  }
  const ask = results.find((r) => r.path === ASK);
  // The reason must name WHICH terms discriminated, not just that something hit.
  expect(ask?.discriminating).toEqual(["wiki"]);
});

// --- AC5 on this surface --------------------------------------------------

test("a nonsense query is a no-match, not an empty success", () => {
  const outcome = findCandidates(CORPUS, "kubernetes helm chart");
  expect(outcome.code).toBe("no-match");
  expect(outcome.files).toEqual([]);
  expect(outcome.nextActions.length).toBeGreaterThan(0);
});

test("a weak lexical signal is insufficient-evidence, not a no-match", () => {
  // "search" hits 57 of 60 files: candidates exist, and none of them is
  // evidence for anything.
  const outcome = findCandidates(CORPUS, "search");
  expect(outcome.code).toBe("insufficient-evidence");
  expect(outcome.ubiquitousTerms).toContain("search");
});

test("a broken or unbuilt index is index-incomplete, not a no-match", () => {
  const outcome = findCandidates({ nodes: [], edges: [] }, "wiki ranking");
  expect(outcome.code).toBe("index-incomplete");
});

test("a query with no content terms is invalid-input, not a silent empty list", () => {
  const outcome = findCandidates(CORPUS, "   ");
  expect(outcome.code).toBe("invalid-input");
});

test("the four AC5 conditions are four different codes on one surface", () => {
  const codes = [
    findCandidates(CORPUS, "kubernetes helm chart").code,
    findCandidates(CORPUS, "search").code,
    findCandidates({ nodes: [], edges: [] }, "wiki").code,
    findCandidates(CORPUS, "").code,
  ];
  expect(new Set(codes).size).toBe(4);
});

test("a successful find is ok", () => {
  expect(findCandidates(CORPUS, QUERY).code).toBe("ok");
});
