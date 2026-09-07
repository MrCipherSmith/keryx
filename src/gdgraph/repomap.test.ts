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
  const root = await mkdtemp(path.join(tmpdir(), "keryx-repomap-"));
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

// --- AC2 (AFC-12): seed + known consumers/tests must not suffer alphabetical
// eviction; zero-value ballast must not fill the budget; overflow of the
// required set must be mandatory-reported, not a truncated silent success. ---

// A minimal graph with one seed, its one known consumer, and its one test —
// plus three fully-isolated "ballast" files whose paths sort alphabetically
// BEFORE the consumer/test paths. Under personalization (a seed given), an
// isolated node with no inbound edges scores exactly 0 — same as a genuine
// consumer/test that nothing else imports. Only the required-set membership
// (not the score) can tell them apart.
function seedFixtureGraph(): GraphData {
  return {
    nodes: [
      { id: "src/seed.ts", kind: "file", path: "src/seed.ts", language: "typescript" },
      { id: "src/consumer.ts", kind: "file", path: "src/consumer.ts", language: "typescript" },
      { id: "src/seed.test.ts", kind: "file", path: "src/seed.test.ts", language: "typescript" },
      { id: "src/aaa-ballast.ts", kind: "file", path: "src/aaa-ballast.ts", language: "typescript" },
      { id: "src/bbb-ballast.ts", kind: "file", path: "src/bbb-ballast.ts", language: "typescript" },
      { id: "src/zzz-ballast.ts", kind: "file", path: "src/zzz-ballast.ts", language: "typescript" },
    ],
    edges: [
      { id: "e1", from: "src/consumer.ts", to: "src/seed.ts", kind: "imports", specifier: "./seed" },
      { id: "e2", from: "src/seed.test.ts", to: "src/seed.ts", kind: "imports", specifier: "./seed" },
    ],
  };
}

test("AC2 — a seed's known consumer and test survive budget eviction over alphabetically-earlier zero-value ballast", async () => {
  const graph = seedFixtureGraph();
  // Budget big enough for the header + exactly the 3 required blocks, nothing more.
  const requiredOnly = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, {
    seed: ["src/seed.ts"],
    budget: 100000,
  });
  const requiredContent = requiredOnly.content;
  const budget = estimateTokens(requiredContent);

  const result = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, { seed: ["src/seed.ts"], budget });

  expect(result.overflow).toBeUndefined();
  const paths = result.entries.map((entry) => entry.path).sort();
  expect(paths).toEqual(["src/consumer.ts", "src/seed.test.ts", "src/seed.ts"]);
  // The alphabetically-earlier ballast never displaced the required set.
  expect(paths).not.toContain("src/aaa-ballast.ts");
  expect(paths).not.toContain("src/bbb-ballast.ts");
});

test("AC2 — zero-value ballast entries are excluded even when the budget has room", async () => {
  const graph = seedFixtureGraph();
  const result = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, {
    seed: ["src/seed.ts"],
    budget: 100000,
  });
  expect(result.overflow).toBeUndefined();
  const paths = result.entries.map((entry) => entry.path);
  expect(paths).not.toContain("src/aaa-ballast.ts");
  expect(paths).not.toContain("src/bbb-ballast.ts");
  expect(paths).not.toContain("src/zzz-ballast.ts");
  expect(result.entries.every((entry) => entry.score > 0 || entry.required)).toBe(true);
});

test("AC2 — a required set that cannot fit as a whole is a mandatory context_overflow, not a truncated success", async () => {
  const graph = seedFixtureGraph();
  // Budget too small even for the single seed entry's own block.
  const result = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, { seed: ["src/seed.ts"], budget: 1 });

  expect(result.overflow).toEqual({ code: "context_overflow", requiredId: expect.any(String) });
  expect(result.entries).toEqual([]);
  expect(result.partial).toBe(false);
});

test("AC2 — optional overflow is visible: omitted paths are named and continuation guidance is present", async () => {
  const graph = seedFixtureGraph();
  const requiredOnly = computeRepomap(graph, DEFAULT_GDGRAPH_CONFIG, {
    seed: ["src/seed.ts"],
    budget: 100000,
  });
  const requiredTokens = estimateTokens(requiredOnly.content);

  // A genuine optional entry needs real (non-zero) score, which — under
  // personalization — only reaches a node the seed's own rank mass flows
  // TO. Add a dependency of the seed (not a consumer/test, so NOT required)
  // and give it many long symbols so its rendered block is large — it must
  // not fit in a small leftover-budget slack, while a short omission
  // marker does.
  const withDependency: GraphData = {
    nodes: [...graph.nodes, { id: "src/seed-dep.ts", kind: "file", path: "src/seed-dep.ts", language: "typescript" }],
    edges: [
      ...graph.edges,
      { id: "e3", from: "src/seed.ts", to: "src/seed-dep.ts", kind: "imports", specifier: "./seed-dep" },
    ],
    symbols: Array.from({ length: 12 }, (_, i) => ({
      id: `src/seed-dep.ts#fn${i}`,
      kind: "function" as const,
      path: "src/seed-dep.ts",
      name: `exampleFunctionWithALongNameNumber${i}`,
      container: null,
      startLine: i + 1,
      endLine: i + 2,
      language: "typescript",
      signature: `exampleFunctionWithALongNameNumber${i}(argumentOne: string, argumentTwo: number): void`,
    })),
  };

  // Enough slack for the marker + guidance, nowhere near enough for the
  // 12-signature seed-dep.ts block.
  const budget = requiredTokens + 40;
  const result = computeRepomap(withDependency, DEFAULT_GDGRAPH_CONFIG, {
    seed: ["src/seed.ts"],
    budget,
  });

  expect(result.overflow).toBeUndefined();
  expect(result.tokens).toBeLessThanOrEqual(budget);
  const paths = result.entries.map((entry) => entry.path).sort();
  expect(paths).toEqual(["src/consumer.ts", "src/seed.test.ts", "src/seed.ts"]);
  expect(result.partial).toBe(true);
  expect(result.omittedOptional).toContain("src/seed-dep.ts");
  expect(result.content).toContain("Increase --budget");
});
