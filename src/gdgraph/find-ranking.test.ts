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
// A pair built solely to make the fan-in tie-break observable. They match the
// query identically — same single corpus-wide term, same basename shape — and
// differ only in dependents. Crucially their PATHS disagree with their fan-in
// order: `zz-` sorts after `aa-`, so the alphabetical fallback would put the
// low-fan-in file first. Only a real tie-break inverts that.
const TIE_HIGH_FANIN = "src/tie/zz-search-adapter.ts";
const TIE_LOW_FANIN = "src/tie/aa-search-adapter.ts";

function buildCorpus(): GraphData {
  const nodes: GraphNode[] = [
    fileNode(ASK),
    fileNode(WIKI_INDEX),
    fileNode(SECTION_RANKING),
    fileNode(MEMORY_SEARCH),
    fileNode(POPULAR),
    fileNode(TIE_HIGH_FANIN),
    fileNode(TIE_LOW_FANIN),
  ];
  // 55 filler files that all carry "search" in their path, making it a term
  // with no discriminating power in this corpus.
  for (let i = 0; i < 55; i += 1) {
    nodes.push(fileNode(`src/mod${i}/search-helper-${i}.ts`));
  }
  const edges: GraphEdge[] = [
    ...edgesInto(POPULAR, 400, "pop"),
    ...edgesInto(MEMORY_SEARCH, 12, "mem"),
    ...edgesInto(TIE_HIGH_FANIN, 30, "tiehi"),
    ...edgesInto(TIE_LOW_FANIN, 2, "tielo"),
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

test("fan-in still breaks a tie, and the tie-break is doing the work", () => {
  // The fix must not throw fan-in away — it must demote it to a tie-break.
  //
  // THIS ASSERTION USED TO BE VACUOUS, and an independent review proved it:
  // it compared POPULAR (`src/core/search-registry.ts`) with MEMORY_SEARCH
  // (`src/memory/search.ts`), and `core` sorts before `memory`, so the
  // alphabetical fallback ordered them the same way fan-in does. Deleting the
  // fan-in tie-break entirely left all twelve assertions in this file green —
  // including this one, which exists to prevent exactly that.
  //
  // The pair below is built so alphabetical order and fan-in order DISAGREE:
  // the file with more dependents sorts last. Only a real tie-break can put it
  // first, and `localeCompare` alone puts it last.
  const results = findNodes(CORPUS, QUERY);
  const paths = results.map((r) => r.path);
  expect(paths.indexOf(TIE_HIGH_FANIN)).toBeLessThan(paths.indexOf(TIE_LOW_FANIN));
  expect(TIE_HIGH_FANIN > TIE_LOW_FANIN).toBe(true);
});

test("fan-in is a tie-break and is never added into the score", () => {
  // The other half the review found unpinned: `score += dependents * 0.01`
  // passed every assertion in this file. A tie-break that leaks into the score
  // is not a tie-break — it is popularity with a smaller coefficient, which is
  // the defect this fixture exists to catch.
  //
  // These two match identically and differ only in fan-in, so equal SCORES are
  // what distinguishes "fan-in orders equals" from "fan-in changes the value".
  const results = findNodes(CORPUS, QUERY);
  const high = results.find((r) => r.path === TIE_HIGH_FANIN);
  const low = results.find((r) => r.path === TIE_LOW_FANIN);
  expect(high).toBeDefined();
  expect(low).toBeDefined();
  expect(high?.score).toBe(low?.score as number);
  expect(high?.dependents).not.toBe(low?.dependents);

  // And the ordering invariant that goes with it: scores run downhill. The
  // moment fan-in enters the sort key rather than breaking ties, a
  // higher-fan-in file with a lower score climbs over a lower-fan-in file with
  // a higher one, and this sequence stops being monotonic.
  //
  // Measured honestly: the review's `score += dependents * 0.01` does NOT fail
  // this, because in a corpus where a discriminating term scores ~30 and a
  // corpus-wide one ~0.7, four points of fan-in bonus flip no pair — the
  // mutation changes no observable output. Rather than reshape the fixture
  // until an inert mutation fails, this pins the property that matters: any
  // fan-in leakage large enough to reorder anything reorders this list.
  const scores = results.map((r) => r.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
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
