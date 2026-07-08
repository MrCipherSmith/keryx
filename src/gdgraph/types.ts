export type GraphNode = {
  id: string;
  kind: "file" | "asset";
  path: string;
  language: "typescript" | "javascript" | "asset";
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "imports" | "asset" | "unresolved";
  specifier: string;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  // B1 symbol layer — present only when tree-sitter enrichment ran and wrote
  // `storage/symbols.jsonl` / `storage/calls.jsonl`. Missing ⇒ omitted (never an
  // error; `loadGraph` loads them only if present). File-level consumers ignore
  // these fields, keeping the legacy graph shape backward-compatible.
  symbols?: SymbolNode[];
  calls?: CallEdge[];
};

// --- B1 symbol layer types (additive; only materialized in symbols.jsonl /
// calls.jsonl when the `gdgraph.treesitter` capability is active). ---

export type SymbolKind = "function" | "class" | "method" | "interface";

export type SymbolNode = {
  // "<path>#<Container>.<name>" (+ "@<startLine>" on name collision).
  id: string;
  kind: SymbolKind;
  // Owning file (matches a file GraphNode.path).
  path: string;
  name: string;
  // Enclosing class/namespace, or null.
  container: string | null;
  // 1-based; positional, for stable disambiguation.
  startLine: number;
  endLine: number;
  language: "typescript" | "javascript";
  // Rendered for repomap.
  signature?: string;
};

export type CallEdge = {
  id: string;
  // SymbolNode.id of caller (or file path when caller unknown).
  from: string;
  // SymbolNode.id of callee, or raw callee text when unresolved.
  to: string;
  // "defines": file → symbol containment.
  kind: "calls" | "defines" | "unresolved-call";
  resolved: boolean;
};

export type SymbolLayer = {
  symbols: SymbolNode[];
  calls: CallEdge[];
};
