// T14 (flow 235) — the retrieval CODE is a claim about the corpus, and a
// ranking decision may never be allowed to make that claim false.
//
// REPRODUCED DEFECT (real `keryx gdgraph build`, real CLI, 2026-09-08). A temp
// project of 14 files, every one of them under `alpha/`:
//
//   $ keryx gdgraph find "alpha" --json
//   { "code": "no-match",
//     "reason": "the search completed over 14 indexed files; no path or symbol
//                contains any of: alpha.",
//     "ubiquitousTerms": ["alpha"], "files": [] }          exit=0
//
// Every path contains `alpha`, and the payload said so itself two fields later.
// `no-match` is a statement about the world — "nothing here contains this" —
// and here it was simply untrue, at exit 0, sending the caller to a text search
// they did not need. That is the exact failure the retrieval codes exist to
// remove, committed by the code that implements them.
//
// The mechanism was ballast-dropping: `alpha` is in ALL 14 documents, so its
// weight is `log(15/15) = 0`, every file scored zero, the ranking filter
// removed every one of them, and the classifier read the resulting empty list
// as "nothing matched". The correct outcome is `insufficient-evidence` — the
// condition already existed, with the right reason text and the right next
// actions; the classifier just never got to see that there had been matches.
//
// These tests therefore assert the SEPARATION, not the arithmetic: whatever the
// scoring formula is, a file that matched something must not be classified the
// same as a file that matched nothing.

import { expect, test } from "bun:test";
import { findCandidates, findNodes, findSymbols } from "./find";
import type { GraphData, GraphNode, SymbolNode } from "./types";

function fileNode(path: string): GraphNode {
  return { id: path, kind: "file", path, language: "typescript" };
}

function sym(name: string, path: string, line: number): SymbolNode {
  return {
    id: `${path}#${name}`,
    kind: "function",
    path,
    name,
    container: null,
    startLine: line,
    endLine: line + 2,
    language: "typescript",
  };
}

/**
 * The reviewer's corpus, byte for byte: 14 files, all under `alpha/`, so
 * `alpha` has document frequency == corpus size.
 */
const ALPHA_CORPUS: GraphData = {
  nodes: Array.from({ length: 14 }, (_, i) => fileNode(`alpha/mod${i + 1}.ts`)),
  edges: [],
};

// --- The reproduction, as a unit test -------------------------------------

test("a term in EVERY path is insufficient-evidence, never a no-match", () => {
  const outcome = findCandidates(ALPHA_CORPUS, "alpha");

  // The defect: this was "no-match".
  expect(outcome.code).toBe("insufficient-evidence");
  expect(outcome.ubiquitousTerms).toEqual(["alpha"]);
});

test("the ranking still drops the ballast — it just no longer decides the code", () => {
  // Both halves matter. If `findNodes` started returning the zero-score files,
  // the fix would have bought the code at the price of the ranking that phase 3
  // pinned. It must return nothing here AND the classifier must still know that
  // fourteen files matched.
  expect(findNodes(ALPHA_CORPUS, "alpha")).toEqual([]);

  const outcome = findCandidates(ALPHA_CORPUS, "alpha");
  expect(outcome.files).toEqual([]);
  expect(outcome.code).toBe("insufficient-evidence");
  expect(outcome.reason).toContain("14 candidates matched");
});

test("the same corpus still reports a genuine absence as a no-match", () => {
  // The fix must not buy consistency by never saying `no-match` again.
  const outcome = findCandidates(ALPHA_CORPUS, "kubernetes helm chart");
  expect(outcome.code).toBe("no-match");
  expect(outcome.ubiquitousTerms).toEqual([]);
});

test("the symbol layer has the identical failure, and the identical fix", () => {
  // Every symbol name carries `handler`, so its weight over the NAME corpus is
  // zero and every symbol is ballast — while the files match nothing at all.
  // Before the fix this was `no-match` too.
  const graph: GraphData = {
    nodes: Array.from({ length: 14 }, (_, i) => fileNode(`src/mod${i}.ts`)),
    edges: [],
    symbols: Array.from({ length: 14 }, (_, i) =>
      sym(`handler${i}Impl`, `src/mod${i}.ts`, i + 1),
    ),
  };

  expect(findSymbols(graph, "handler")).toEqual([]);
  expect(findCandidates(graph, "handler").code).toBe("insufficient-evidence");
});

// --- The consistency the payload must never break again -------------------

/**
 * The corpora below are deliberately varied in the one dimension that produced
 * the bug: how close a term's document frequency sits to the corpus size.
 */
const CORPORA: ReadonlyArray<{ name: string; graph: GraphData }> = [
  { name: "all-alpha (df == N)", graph: ALPHA_CORPUS },
  {
    name: "one term corpus-wide, one rare",
    graph: {
      nodes: [
        fileNode("src/wiki/ask.ts"),
        ...Array.from({ length: 19 }, (_, i) => fileNode(`src/mod${i}/search-${i}.ts`)),
      ],
      edges: [],
    },
  },
  {
    name: "shared prefix only (df == N on 'src')",
    graph: {
      nodes: [
        fileNode("src/real-target.ts"),
        ...Array.from({ length: 19 }, (_, i) => fileNode(`src/filler-${i}.ts`)),
      ],
      edges: [],
    },
  },
  {
    name: "small corpus, under MIN_WEIGHTED_CORPUS",
    graph: { nodes: [fileNode("src/a.ts"), fileNode("src/b.ts")], edges: [] },
  },
  {
    name: "single file",
    graph: { nodes: [fileNode("alpha/only.ts")], edges: [] },
  },
];

const QUERIES = [
  "alpha",
  "src",
  "src target",
  "search",
  "wiki search",
  "wiki",
  "only",
  "kubernetes helm chart",
  "mod",
  "ts",
];

/**
 * The oracle: `no-match` says no path contains any query term. Check it against
 * the graph, with the same predicate `findNodes` matches with. This is the
 * assertion the shipped defect fails — it does not look at the implementation's
 * intermediate state, it looks at the world the reason describes.
 */
function pathsContaining(graph: GraphData, term: string): string[] {
  return graph.nodes
    .filter((node) => node.kind === "file")
    .map((node) => node.path.toLowerCase())
    .filter((path) => path.includes(term));
}

test("a no-match is never contradicted by the corpus it claims to describe", () => {
  for (const { name, graph } of CORPORA) {
    for (const query of QUERIES) {
      const outcome = findCandidates(graph, query);
      if (outcome.code !== "no-match") {
        continue;
      }
      for (const term of outcome.queryTerms) {
        const hits = pathsContaining(graph, term);
        expect(
          `${name} / "${query}" / "${term}" → ${hits.length} paths contain it`,
        ).toBe(`${name} / "${query}" / "${term}" → 0 paths contain it`);
      }
    }
  }
});

test("a no-match is never contradicted by its own payload", () => {
  // A ubiquitous term is BY DEFINITION in more than half the indexed paths, so
  // a non-empty `ubiquitousTerms` beside a reason saying nothing contains the
  // query is a self-contradiction inside one object. That is what shipped.
  for (const { name, graph } of CORPORA) {
    for (const query of QUERIES) {
      const outcome = findCandidates(graph, query);
      if (outcome.code === "no-match" && outcome.ubiquitousTerms.length > 0) {
        throw new Error(
          `${name} / "${query}": code no-match with ubiquitousTerms ` +
            `[${outcome.ubiquitousTerms.join(", ")}] — reason said "${outcome.reason}"`,
        );
      }
    }
  }
});

test("the reason text and the code always agree about what was found", () => {
  for (const { name, graph } of CORPORA) {
    for (const query of QUERIES) {
      const outcome = findCandidates(graph, query);
      const claimsNothingContains = outcome.reason.includes("no path or symbol contains");
      expect(`${name} / "${query}": ${claimsNothingContains}`).toBe(
        `${name} / "${query}": ${outcome.code === "no-match" && outcome.ubiquitousTerms.length === 0}`,
      );
    }
  }
});

// --- The other display decision that must not reach the classifier --------

test("a page full of noise does not become a claim that the corpus is all noise", () => {
  // The second way ranking used to leak into classification. `insufficient-
  // evidence` says "EVERY candidate matched only on <corpus-wide terms>" — a
  // universal claim. Reading it off the displayed page makes it false the
  // moment a discriminating match exists below the cut.
  //
  // 120 files. `alpha` and `beta` are each in 62 of them (ubiquitous); `gamma`
  // is in the other 58 (not ubiquitous, so it discriminates). A file hitting
  // both corpus-wide terms in its basename outscores a file hitting the one
  // narrowing term, so all 20 displayed candidates are noise — while 58
  // genuinely discriminating candidates sit just below.
  const nodes: GraphNode[] = [];
  for (let i = 0; i < 62; i += 1) {
    nodes.push(fileNode(`m${i}/alpha-beta-${i}.ts`));
  }
  for (let i = 0; i < 58; i += 1) {
    nodes.push(fileNode(`n${i}/gamma-${i}.ts`));
  }
  const graph: GraphData = { nodes, edges: [] };
  const outcome = findCandidates(graph, "alpha beta gamma");

  // The premise: the displayed page really is all noise, so this test is
  // testing what it claims to test rather than passing by accident.
  expect(outcome.files.length).toBeGreaterThan(0);
  expect(outcome.files.every((file) => file.discriminating.length === 0)).toBe(true);
  // And the corpus really does hold discriminating matches.
  expect(findNodes(graph, "gamma", 500).some((f) => f.discriminating.includes("gamma"))).toBe(true);

  // So the verdict must not be the universal claim. Each candidate still says
  // for itself that it narrowed nothing — that is where the caution belongs.
  expect(outcome.code).toBe("ok");
  expect(outcome.reason).not.toContain("every one of them");
  expect(outcome.files[0]?.reason).toContain("no narrowing term");
});

test("the result limit is a display cut, not a verdict on the corpus", () => {
  const graph: GraphData = {
    nodes: [
      fileNode("src/wiki/ask.ts"),
      fileNode("src/wiki/loader.ts"),
      ...Array.from({ length: 18 }, (_, i) => fileNode(`src/mod${i}/other-${i}.ts`)),
    ],
    edges: [],
  };
  // Asking for one file and zero-ish symbols must not turn a real hit into a
  // different code — `limit` decides page size, nothing else.
  const full = findCandidates(graph, "wiki");
  const cut = findCandidates(graph, "wiki", { fileLimit: 1, symbolLimit: 1 });
  expect(cut.code).toBe(full.code);
  expect(cut.code).toBe("ok");
  expect(cut.files.length).toBe(1);
});
