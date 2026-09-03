export type GraphNode = {
  id: string;
  // "wiki-page" (LWG-1, flow 223) makes a wiki page a first-class graph node
  // so `describes` edges can be traversed in both directions. Its `id` is
  // "wiki:<wiki-relative path>", e.g. "wiki:components/src-ctx.md".
  kind: "file" | "asset" | "wiki-page";
  path: string;
  language: "typescript" | "javascript" | "java" | "python" | "asset" | "markdown";
  // LWG-2 (flow 223): sha256 of the file's content and its mtime at build
  // time. OPTIONAL on purpose — a graph written by an older keryx has
  // neither, and must keep loading unchanged (same additive contract as the
  // B1 symbol layer below). Absent ⇒ "not recorded", never "empty file".
  // Only ever set for `file` and `wiki-page` nodes; an `asset` node is not
  // read for content.
  contentHash?: string;
  mtimeMs?: number;
};

// Import classification straight from `Bun.Transpiler#scanImports` (P1
// remediation, flow 140). A static `import`/`export ... from` statement is a
// load-order dependency; `dynamic-import` (`await import()`) resolves at call
// time and is not. The full union mirrors every literal `scanImports` can
// return (bun-types `ImportKind`), so a transpiler-found edge always carries
// the value the transpiler actually reported — never a guess.
export type TranspilerImportKind =
  | "import-statement"
  | "require-call"
  | "require-resolve"
  | "dynamic-import"
  | "import-rule"
  | "url-token"
  | "internal"
  | "entry-point-run"
  | "entry-point-build";

// A specifier found ONLY by the regex fallback (`extractImportSpecifiersFallback`
// in build.ts) carries no real kind from the transpiler — the fallback is a
// plain regex with no notion of "static" vs "dynamic". Never infer one;
// `UNKNOWN_IMPORT_KIND` marks it explicitly and cycle detection treats it as
// load-order (the pre-fix behavior), so fallback-only edges are never
// silently excluded from a real cycle.
export const UNKNOWN_IMPORT_KIND = "unknown-static" as const;

export type ImportKind = TranspilerImportKind | typeof UNKNOWN_IMPORT_KIND;

/**
 * Where a `describes` edge came from, highest precedence first (LWG-1,
 * specification §3.3). An explicit `Describes:` frontmatter list REPLACES the
 * derived set for that page rather than adding to it — a human who names the
 * files a page covers is correcting the derivation, not supplementing it.
 */
export type DescribesOrigin = "frontmatter" | "related-code" | "key-files";

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  // "describes" (LWG-1, flow 223) points FROM a `wiki-page` node TO the file
  // node it documents. Only one direction is stored; the reverse question
  // ("which pages describe this file?") is answered from the incoming-edge
  // index every consumer already builds, not from a mirrored edge.
  kind: "imports" | "asset" | "unresolved" | "describes";
  specifier: string;
  // Provenance/kind of the specifier that produced this edge (P1, flow 140).
  // `buildGraph()` always sets this. Optional (not required) so edge literals
  // constructed before this field existed — test fixtures elsewhere in the
  // repo, or graphs persisted by an older `keryx gdgraph build` — stay valid;
  // `getCycles` treats a missing value as load-order, matching pre-fix
  // behavior rather than crashing or silently mis-classifying.
  importKind?: ImportKind;
  // LWG-1 (flow 223): provenance of a `describes` edge. Absent on every other
  // edge kind, and absent on `describes` edges written before this field
  // existed — a missing value means "origin not recorded", and consumers must
  // not infer `key-files` from its absence.
  describesOrigin?: DescribesOrigin;
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
  language: "typescript" | "javascript" | "java" | "python";
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
