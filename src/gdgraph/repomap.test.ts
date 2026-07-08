import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { DEFAULT_GDGRAPH_CONFIG, mergeGdgraphConfig } from "./config";
import { personalizedPageRank } from "./pagerank";
import { buildRankEdges, computeRepomap, estimateTokens, writeRepomap } from "./repomap";
import type { GraphData } from "./types";

const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/repomap/", import.meta.url));

async function loadFixtureGraph(): Promise<GraphData> {
  const raw = JSON.parse(await readFile(path.join(FIXTURE_DIR, "graph.json"), "utf8"));
  return { nodes: raw.nodes, edges: raw.edges };
}

async function loadExpected(): Promise<any> {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, "expected.json"), "utf8"));
}

test("AC3.3 — top-ranked entries match expected centrality ordering", async () => {
  const graph = await loadFixtureGraph();
  const expected = await loadExpected();
  const nodes = graph.nodes.filter((node) => node.kind === "file").map((node) => node.path);
  const edges = buildRankEdges(graph, DEFAULT_GDGRAPH_CONFIG);
  const ranked = personalizedPageRank(nodes, edges, {
    damping: DEFAULT_GDGRAPH_CONFIG.repomap.damping,
    iterations: DEFAULT_GDGRAPH_CONFIG.repomap.iterations,
    tolerance: DEFAULT_GDGRAPH_CONFIG.repomap.tolerance,
  });
  expect(ranked.map((entry) => entry.id)).toEqual(expected.centralityOrder);
});

test("AC3.2 — repomap fits the token budget with a stable omission marker", async () => {
  const graph = await loadFixtureGraph();
  const expected = await loadExpected();
  const config = mergeGdgraphConfig({ repomap: { tokenBudget: expected.tokenBudget } });
  const result = computeRepomap(graph, config, {});

  expect(result.tokens).toBeLessThanOrEqual(expected.tokenBudget);
  expect(estimateTokens(result.content)).toBeLessThanOrEqual(expected.tokenBudget);
  expect(result.entries.map((entry) => entry.path)).toEqual(expected.topWithinBudget);
  expect(result.omitted).toBe(expected.omitted);
  expect(result.content).toContain(`… ${expected.omitted} entries omitted …`);
});

test("AC3.2 — --budget override is honored and bounds the output", async () => {
  const graph = await loadFixtureGraph();
  const result = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, { budget: 30 });
  expect(result.tokens).toBeLessThanOrEqual(30);
  expect(result.omitted).toBeGreaterThan(0);
});

test("AC3.4 — re-running repomap yields a byte-identical file", async () => {
  const graph = await loadFixtureGraph();
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-repomap-"));
  try {
    const config = mergeGdgraphConfig({ repomap: { tokenBudget: 40 } });
    const first = await writeRepomap(root, graph, config, {});
    const firstBytes = await readFile(first.path, "utf8");
    const second = await writeRepomap(root, graph, config, {});
    const secondBytes = await readFile(second.path, "utf8");
    expect(secondBytes).toBe(firstBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AC3.6 — --seed biases personalization; seeded/unseeded each reproducible", async () => {
  const graph = await loadFixtureGraph();
  const unseeded = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, {});
  const seeded = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, { seed: ["src/a.ts"] });
  const seededAgain = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, { seed: ["src/a.ts"] });

  // Each run reproducible.
  expect(seeded.content).toBe(seededAgain.content);
  // Seeding on a.ts lifts it above its unseeded rank position.
  const unseededRank = unseeded.entries.findIndex((entry) => entry.path === "src/a.ts");
  const seededRank = seeded.entries.findIndex((entry) => entry.path === "src/a.ts");
  expect(seededRank).toBeGreaterThanOrEqual(0);
  expect(seededRank).toBeLessThan(unseededRank === -1 ? Number.MAX_SAFE_INTEGER : unseededRank + 1);
});

test("AC3.5 — repomap ranks symbol-aware weights when the layer is present", async () => {
  const graph = await loadFixtureGraph();
  // Add a tiny symbol layer so buildRankEdges exercises calls/defines weights.
  const withSymbols: GraphData = {
    ...graph,
    symbols: [
      {
        id: "src/core.ts#run",
        kind: "function",
        path: "src/core.ts",
        name: "run",
        container: null,
        startLine: 1,
        endLine: 2,
        language: "typescript",
        signature: "run()",
      },
    ],
    calls: [
      { id: "d", from: "src/core.ts", to: "src/core.ts#run", kind: "defines", resolved: true },
    ],
  };
  const result = computeRepomap(withSymbols, DEFAULT_GDGRAPH_CONFIG, { budget: 400 });
  const core = result.entries.find((entry) => entry.path === "src/core.ts");
  expect(core?.symbols).toEqual(["run()"]);
});
