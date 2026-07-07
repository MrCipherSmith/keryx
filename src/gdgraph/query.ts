import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphData, GraphEdge, GraphNode } from "./types";

export async function loadGraph(projectRoot: string): Promise<GraphData> {
  const storageDir = path.join(projectRoot, ".metaproject", "data", "gdgraph", "storage");
  const nodes = await readJsonl<GraphNode>(path.join(storageDir, "nodes.jsonl"));
  const edges = await readJsonl<GraphEdge>(path.join(storageDir, "edges.jsonl"));
  return { nodes, edges };
}

export function getOrphans(graph: GraphData): string[] {
  const inbound = new Set(
    graph.edges.filter((edge) => edge.kind !== "unresolved").map((edge) => edge.to),
  );
  const outbound = new Set(
    graph.edges.filter((edge) => edge.kind !== "unresolved").map((edge) => edge.from),
  );
  return graph.nodes
    .map((node) => node.path)
    .filter((file) => !inbound.has(file) && !outbound.has(file))
    .sort();
}

export function getAffected(
  graph: GraphData,
  target: string,
): { target: string; dependencies: string[]; dependents: string[] } {
  const normalized = normalizeTarget(target);
  const node = graph.nodes.find(
    (item) => item.path === normalized || item.path.endsWith(normalized),
  );
  const resolvedTarget = node?.path ?? normalized;

  return {
    target: resolvedTarget,
    dependencies: graph.edges
      .filter((edge) => edge.kind !== "unresolved" && edge.from === resolvedTarget)
      .map((edge) => edge.to)
      .sort(),
    dependents: graph.edges
      .filter((edge) => edge.kind !== "unresolved" && edge.to === resolvedTarget)
      .map((edge) => edge.from)
      .sort(),
  };
}

export function getCycles(graph: GraphData): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.path, []);
  }
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") {
      continue;
    }
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycles = new Map<string, string[]>();
  const visited = new Set<string>();
  const stack = new Set<string>();
  const pathStack: string[] = [];

  function visit(node: string): void {
    visited.add(node);
    stack.add(node);
    pathStack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        visit(next);
        continue;
      }

      if (stack.has(next)) {
        const start = pathStack.indexOf(next);
        const cycle = [...pathStack.slice(start), next];
        cycles.set(canonicalCycle(cycle), cycle);
      }
    }

    stack.delete(node);
    pathStack.pop();
  }

  for (const node of graph.nodes.map((item) => item.path)) {
    if (!visited.has(node)) {
      visit(node);
    }
  }

  return [...cycles.values()].sort((a, b) => a.join("").localeCompare(b.join("")));
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, "utf8");
  const items: T[] = [];
  for (const line of content.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed JSONL records so one bad line does not break graph navigation.
    }
  }
  return items;
}

function canonicalCycle(cycle: string[]): string {
  const withoutLast = cycle.slice(0, -1);
  const variants = withoutLast.map((_, index) => [
    ...withoutLast.slice(index),
    ...withoutLast.slice(0, index),
  ].join("->"));
  return variants.sort()[0] ?? cycle.join("->");
}

function normalizeTarget(target: string): string {
  return target.replace(/^\.\//, "").split(path.sep).join("/");
}
