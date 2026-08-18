import { expect, test } from "bun:test";
import { DEFAULT_WIKI_CONFIG } from "./config";
import { classifyPage, computeGraphFanIn, computePageGraphSignals, type PageGraphSignals } from "./classify";
import type { GraphData } from "../gdgraph/types";
import type { WikiPage } from "./types";

const RLM_CONFIG = DEFAULT_WIKI_CONFIG.rlm;

const PAGE: WikiPage = {
  absolutePath: "/repo/.metaproject/wiki/components/alpha.md",
  relativePath: "components/alpha.md",
  pageType: "component",
  title: "Module alpha",
  version: null,
  type: null,
  status: null,
  summary: "",
};

function signals(overrides: Partial<PageGraphSignals> = {}): PageGraphSignals {
  return {
    templateBytes: 1000,
    pageRankScore: 0,
    fanIn: 0,
    stale: false,
    ...overrides,
  };
}

test("T2/classify — small, low-centrality page classifies skip", () => {
  const result = classifyPage(
    PAGE,
    signals({ templateBytes: RLM_CONFIG.classify.skipMaxBytes - 1, pageRankScore: 0, fanIn: 0 }),
    RLM_CONFIG,
  );
  expect(result).toBe("skip");
});

test("T2/classify — high PageRank alone classifies deep, even if small", () => {
  const result = classifyPage(
    PAGE,
    signals({
      templateBytes: RLM_CONFIG.classify.skipMaxBytes - 1,
      pageRankScore: RLM_CONFIG.classify.deepMinPageRank,
      fanIn: 0,
    }),
    RLM_CONFIG,
  );
  expect(result).toBe("deep");
});

test("T2/classify — high fan-in alone classifies deep", () => {
  const result = classifyPage(
    PAGE,
    signals({ templateBytes: 10_000, pageRankScore: 0, fanIn: RLM_CONFIG.classify.deepMinFanIn }),
    RLM_CONFIG,
  );
  expect(result).toBe("deep");
});

test("T2/classify — mid-size, below both deep thresholds classifies light", () => {
  const result = classifyPage(
    PAGE,
    signals({
      templateBytes: RLM_CONFIG.classify.skipMaxBytes + 1,
      pageRankScore: RLM_CONFIG.classify.deepMinPageRank - 0.01,
      fanIn: RLM_CONFIG.classify.deepMinFanIn - 1,
    }),
    RLM_CONFIG,
  );
  expect(result).toBe("light");
});

test("T2/classify — thresholds are inclusive at the deep boundary", () => {
  const atPageRankBoundary = classifyPage(
    PAGE,
    signals({ templateBytes: 10_000, pageRankScore: RLM_CONFIG.classify.deepMinPageRank, fanIn: 0 }),
    RLM_CONFIG,
  );
  const atFanInBoundary = classifyPage(
    PAGE,
    signals({ templateBytes: 10_000, pageRankScore: 0, fanIn: RLM_CONFIG.classify.deepMinFanIn }),
    RLM_CONFIG,
  );
  expect(atPageRankBoundary).toBe("deep");
  expect(atFanInBoundary).toBe("deep");
});

test("T2/classify — deep bar wins over skip bar when both would otherwise apply", () => {
  // Tiny page (below skipMaxBytes) but with a graph signal over the deep bar:
  // deep must win, not skip (deep check runs before the skip check).
  const result = classifyPage(
    PAGE,
    signals({
      templateBytes: RLM_CONFIG.classify.skipMaxBytes - 1,
      pageRankScore: RLM_CONFIG.classify.deepMinPageRank,
      fanIn: 0,
    }),
    RLM_CONFIG,
  );
  expect(result).toBe("deep");
});

test("T2/classify — signals.stale is not consulted by classifyPage itself", () => {
  const base = signals({ templateBytes: 10_000, pageRankScore: 0, fanIn: 0 });
  const staleResult = classifyPage(PAGE, { ...base, stale: true }, RLM_CONFIG);
  const freshResult = classifyPage(PAGE, { ...base, stale: false }, RLM_CONFIG);
  expect(staleResult).toBe(freshResult);
});

function fixtureGraph(): GraphData {
  return {
    nodes: [
      { id: "src/hub.ts", kind: "file", path: "src/hub.ts", language: "typescript" },
      { id: "src/a.ts", kind: "file", path: "src/a.ts", language: "typescript" },
      { id: "src/b.ts", kind: "file", path: "src/b.ts", language: "typescript" },
      { id: "src/leaf.ts", kind: "file", path: "src/leaf.ts", language: "typescript" },
    ],
    edges: [
      { id: "e1", from: "src/a.ts", to: "src/hub.ts", kind: "imports", specifier: "./hub" },
      { id: "e2", from: "src/b.ts", to: "src/hub.ts", kind: "imports", specifier: "./hub" },
      // Unresolved edges must not count toward fan-in (mirrors affected.ts).
      { id: "e3", from: "src/unknown.ts", to: "src/hub.ts", kind: "unresolved", specifier: "./missing" },
    ],
  };
}

test("T2/computeGraphFanIn — counts inbound non-unresolved edges only", () => {
  const fanIn = computeGraphFanIn(fixtureGraph());
  expect(fanIn.get("src/hub.ts")).toBe(2);
  expect(fanIn.get("src/leaf.ts")).toBeUndefined();
});

test("T2/computePageGraphSignals — takes the max over a page's key files", () => {
  const fanIn = computeGraphFanIn(fixtureGraph());
  const pageRank = new Map<string, number>([
    ["src/hub.ts", 0.9],
    ["src/leaf.ts", 0.1],
  ]);

  const signalsForHubPage = computePageGraphSignals(
    ["src/hub.ts", "src/leaf.ts"],
    pageRank,
    fanIn,
    1234,
    false,
  );
  expect(signalsForHubPage).toEqual({
    templateBytes: 1234,
    pageRankScore: 0.9,
    fanIn: 2,
    stale: false,
  });

  const signalsForUnknownFiles = computePageGraphSignals([], pageRank, fanIn, 10, true);
  expect(signalsForUnknownFiles).toEqual({
    templateBytes: 10,
    pageRankScore: 0,
    fanIn: 0,
    stale: true,
  });
});

test("T2/computePageGraphSignals + classifyPage — end-to-end deep classification via graph signals", () => {
  const graph = fixtureGraph();
  const fanIn = computeGraphFanIn(graph);
  const pageRank = new Map<string, number>([["src/hub.ts", RLM_CONFIG.classify.deepMinPageRank]]);
  const pageSignals = computePageGraphSignals(["src/hub.ts"], pageRank, fanIn, 500, false);
  expect(classifyPage(PAGE, pageSignals, RLM_CONFIG)).toBe("deep");
});
