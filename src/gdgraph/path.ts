import type { GraphData, SymbolNode } from "./types";
import { resolveSymbols } from "./symbol";

// "How are A and B connected?" — shortest path over a UNIFIED graph that spans
// both layers: file import edges, symbol call edges, and file→symbol "defines"
// bridges (a symbol's owning file). Endpoints may be file paths or symbol names.
// Undirected BFS so a connection is found regardless of edge direction; the
// rendered chain still shows the concrete hops. Pure over the in-memory graph.

export interface PathResult {
  fromToken: string;
  toToken: string;
  fromResolved: string[];
  toResolved: string[];
  // Node-id chain from an A-endpoint to a B-endpoint, or [] when unconnected.
  nodes: string[];
}

// Resolve an endpoint token to candidate node ids: exact file path, then symbol
// name matches, then file-path substring.
function resolveEndpoint(graph: GraphData, token: string): string[] {
  const filePaths = new Set(
    graph.nodes.filter((n) => n.kind === "file").map((n) => n.path),
  );
  if (filePaths.has(token)) {
    return [token];
  }
  const bySymbol = resolveSymbols(graph.symbols ?? [], token, 10).map((s) => s.id);
  if (bySymbol.length > 0) {
    return bySymbol;
  }
  return [...filePaths].filter((p) => p.includes(token));
}

function buildAdjacency(graph: GraphData): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };

  for (const edge of graph.edges) {
    link(edge.from, edge.to); // file → file imports
  }
  const symbolIds = new Set((graph.symbols ?? []).map((s) => s.id));
  for (const symbol of graph.symbols ?? []) {
    link(symbol.path, symbol.id); // file defines symbol (layer bridge)
  }
  for (const call of graph.calls ?? []) {
    if (call.kind === "calls" && symbolIds.has(call.from) && symbolIds.has(call.to)) {
      link(call.from, call.to); // resolved symbol → symbol call
    }
  }
  return adj;
}

function bfs(adj: Map<string, Set<string>>, starts: string[], goals: Set<string>): string[] {
  const prev = new Map<string, string | null>();
  const queue: string[] = [];
  for (const start of starts) {
    if (!prev.has(start)) {
      prev.set(start, null);
      queue.push(start);
    }
  }

  let found: string | null = null;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (goals.has(current)) {
      found = current;
      break;
    }
    for (const next of adj.get(current) ?? []) {
      if (!prev.has(next)) {
        prev.set(next, current);
        queue.push(next);
      }
    }
  }

  if (found === null) {
    return [];
  }
  const chain: string[] = [];
  let node: string | null = found;
  while (node !== null) {
    chain.unshift(node);
    node = prev.get(node) ?? null;
  }
  return chain;
}

export function findPath(graph: GraphData, fromToken: string, toToken: string): PathResult {
  const fromResolved = resolveEndpoint(graph, fromToken);
  const toResolved = resolveEndpoint(graph, toToken);
  if (fromResolved.length === 0 || toResolved.length === 0) {
    return { fromToken, toToken, fromResolved, toResolved, nodes: [] };
  }
  const adj = buildAdjacency(graph);
  const nodes = bfs(adj, fromResolved, new Set(toResolved));
  return { fromToken, toToken, fromResolved, toResolved, nodes };
}

// Render a node id as a human label: "name (path:line)" for a symbol, else the
// file path verbatim.
export function labelNode(nodeId: string, symbolsById: Map<string, SymbolNode>): string {
  const symbol = symbolsById.get(nodeId);
  return symbol ? `${symbol.name} (${symbol.path}:${symbol.startLine})` : nodeId;
}
