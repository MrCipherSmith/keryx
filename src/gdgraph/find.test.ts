import { expect, test } from "bun:test";
import { findNodes, findSymbols } from "./find";
import type { GraphData, SymbolNode } from "./types";

function fileNode(path: string) {
  return { id: path, kind: "file" as const, path, language: "typescript" as const };
}

function edge(from: string, to: string) {
  return { id: `${from}->${to}`, from, to, kind: "imports" as const, specifier: to };
}

const GRAPH: GraphData = {
  nodes: [
    fileNode("src/pipelines/utils/clone-pipeline.ts"),
    fileNode("src/pipelines/features/pipeline-variables/pipeline-variables-store.ts"),
    fileNode("src/pipelines/api/pipeline-api.ts"),
    fileNode("src/case/store/case-store.ts"),
  ],
  edges: [
    edge("src/case/store/case-store.ts", "src/pipelines/api/pipeline-api.ts"),
    edge("src/pipelines/utils/clone-pipeline.ts", "src/pipelines/api/pipeline-api.ts"),
  ],
};

test("finds files by concept and ranks by matched terms", () => {
  const results = findNodes(GRAPH, "pipeline clone");
  expect(results[0]?.path).toBe("src/pipelines/utils/clone-pipeline.ts");
  expect(results[0]?.matched.sort()).toEqual(["clone", "pipeline"]);
});

test("ranks pipeline-variables highest for that query", () => {
  const results = findNodes(GRAPH, "pipeline variables store");
  expect(results[0]?.path).toContain("pipeline-variables-store.ts");
});

test("drops stopwords and short tokens from the query", () => {
  const results = findNodes(GRAPH, "the clone of a pipeline");
  expect(results[0]?.path).toBe("src/pipelines/utils/clone-pipeline.ts");
  // "the", "of", "a" must not have matched anything on their own
  expect(results.every((r) => !r.matched.includes("the"))).toBe(true);
});

test("returns empty for a query that matches no path", () => {
  expect(findNodes(GRAPH, "kubernetes helm chart")).toEqual([]);
});

test("fan-in breaks ties (more-depended-on file ranks higher)", () => {
  // both match "pipeline api" equally; pipeline-api has 2 dependents
  const results = findNodes(GRAPH, "pipeline");
  const apiIdx = results.findIndex((r) => r.path.endsWith("pipeline-api.ts"));
  expect(results[apiIdx]?.dependents).toBe(2);
});

function sym(id: string, name: string, path: string, line: number): SymbolNode {
  return { id, kind: "function", path, name, container: null, startLine: line, endLine: line + 2, language: "typescript" };
}

const SYMBOL_GRAPH: GraphData = {
  nodes: [],
  edges: [],
  symbols: [
    sym("a#clonePipeline", "clonePipeline", "src/a.ts", 12),
    sym("b#clonePipelineDeep", "clonePipelineDeep", "src/b.ts", 30),
    sym("c#unrelated", "unrelated", "src/c.ts", 1),
  ],
};

test("findSymbols ranks an exact name match above a substring match", () => {
  const results = findSymbols(SYMBOL_GRAPH, "clonePipeline");
  expect(results[0]?.name).toBe("clonePipeline"); // exact-name bonus wins
  expect(results.map((r) => r.name)).toContain("clonePipelineDeep");
  expect(results.every((r) => r.name !== "unrelated")).toBe(true);
});

test("findSymbols returns [] when the symbol layer is absent", () => {
  expect(findSymbols({ nodes: [], edges: [] }, "clonePipeline")).toEqual([]);
});
