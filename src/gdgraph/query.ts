import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CallEdge,
  DescribesEdge,
  GraphData,
  GraphEdge,
  GraphNode,
  SymbolNode,
  WikiPageNode,
} from "./types";
import { resolveGraphTarget } from "./target";

export async function loadGraph(projectRoot: string): Promise<GraphData> {
  const storageDir = path.join(projectRoot, ".metaproject", "data", "gdgraph", "storage");
  const nodes = await readJsonl<GraphNode>(path.join(storageDir, "nodes.jsonl"));
  const edges = await readJsonl<GraphEdge>(path.join(storageDir, "edges.jsonl"));
  // B1 symbol layer: loaded ONLY if present. Missing files ⇒ empty/omitted layer
  // (never an error — mirrors `readJsonl` tolerance). File-level graph unchanged.
  const symbols = await readJsonl<SymbolNode>(path.join(storageDir, "symbols.jsonl"));
  const calls = await readJsonl<CallEdge>(path.join(storageDir, "calls.jsonl"));
  // LWG wiki layer (flow 223): same contract as the symbol layer above —
  // loaded only if present, absent ⇒ omitted, never an error. A graph built
  // before this layer existed therefore loads byte-for-byte as it always did.
  const wikiPages = await readJsonl<WikiPageNode>(path.join(storageDir, "wiki-pages.jsonl"));
  const describes = await readJsonl<DescribesEdge>(path.join(storageDir, "describes.jsonl"));
  const graph: GraphData = { nodes, edges };
  if (symbols.length > 0) {
    graph.symbols = symbols;
  }
  if (calls.length > 0) {
    graph.calls = calls;
  }
  if (wikiPages.length > 0) {
    graph.wikiPages = wikiPages;
  }
  if (describes.length > 0) {
    graph.describes = describes;
  }
  return graph;
}

/**
 * Reverse the `describes` layer: which wiki pages document this file?
 * (LWG-1, flow 223 AC3.)
 *
 * The layer stores only page → file, so this is the index every caller would
 * otherwise rebuild. An absent layer yields an empty array — the honest
 * answer is "no information", and a caller must not read that as "this file
 * is undocumented"; only a layer that IS present can support that claim.
 */
export function getPagesDescribing(graph: GraphData, filePath: string): string[] {
  const target = filePath.replace(/^\.\//, "");
  const pages = new Set<string>();
  for (const edge of graph.describes ?? []) {
    if (edge.to === target) {
      pages.add(edge.from);
    }
  }
  return [...pages].sort();
}

/** Every file the given page documents (LWG-1). Empty when undecidable. */
export function getFilesDescribedBy(graph: GraphData, pageId: string): string[] {
  const files = new Set<string>();
  for (const edge of graph.describes ?? []) {
    if (edge.from === pageId) {
      files.add(edge.to);
    }
  }
  return [...files].sort();
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
  // Exact-then-suffix, refusing an ambiguous suffix (see ./target.ts). Shared
  // with `computeAffected` so the two entry points cannot drift apart.
  const resolvedTarget = resolveGraphTarget(graph, target);

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
    // A `dynamic-import` (`await import()`) resolves at call time, not
    // module-load time, so a cycle closed only through one is not the
    // load-order cycle this query answers (P1, flow 140). Excluding it here
    // — rather than reclassifying `edge.kind` — leaves orphans/affected
    // untouched (AC5): both still treat the edge as a normal import.
    if (edge.kind !== "imports" || edge.importKind === "dynamic-import") {
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
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    // Absent file ⇒ empty layer (the symbol layer is optional, and a missing
    // core file should degrade rather than crash graph navigation).
    return [];
  }
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
