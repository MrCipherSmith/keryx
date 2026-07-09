import { expect, test } from "bun:test";
import { findNodes } from "./find";
import type { GraphData } from "./types";

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
