export type GraphNode = {
  id: string;
  kind: "file" | "asset";
  path: string;
  language: "typescript" | "javascript" | "java" | "python" | "asset";
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

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: "imports" | "asset" | "unresolved";
  specifier: string;
  // Provenance/kind of the specifier that produced this edge (P1, flow 140).
  // `buildGraph()` always sets this. Optional (not required) so edge literals
  // constructed before this field existed — test fixtures elsewhere in the
  // repo, or graphs persisted by an older `keryx gdgraph build` — stay valid;
  // `getCycles` treats a missing value as load-order, matching pre-fix
  // behavior rather than crashing or silently mis-classifying.
  importKind?: ImportKind;
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
  // LWG wiki layer (flow 223) — present only when `storage/wiki-pages.jsonl` /
  // `storage/describes.jsonl` exist. Same additive contract as the symbol
  // layer: missing ⇒ omitted, never an error, and file-level consumers that
  // ignore these fields keep the legacy graph shape.
  wikiPages?: WikiPageNode[];
  describes?: DescribesEdge[];
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

// --- LWG wiki layer (flow 223, phase 0; additive, materialized only in
// `storage/wiki-pages.jsonl` / `storage/describes.jsonl`). ---
//
// WHY A SEPARATE LAYER rather than new `kind`s inside `nodes.jsonl` /
// `edges.jsonl`, which the package specification originally called for:
// five production call sites treat "every node that is not `asset`" as a
// source file — `validModuleNames` and `collectGraphWikiCandidates`
// (`src/wiki/service.ts:365,412`), `computeModuleKeyFiles`
// (`src/wiki/collect.ts:97`) and `src/commands/update.ts:869`. A page node
// in `nodes.jsonl` would be grouped by `moduleNameFromProjectPath` into a
// fabricated module (`.metaproject/wiki/components`) and would corrupt the
// very module set `wikiPruneOrphans` and `src/sac/lifecycle-flag.ts` use to
// decide what is orphaned. Keeping the layer separate also preserves the
// build's existing rule that additive layers never rewrite the legacy
// artifacts (see `build.ts`'s symbol-layer enrichment).

/**
 * Where a `describes` relation came from, highest precedence first
 * (specification §3.3). An explicit `Describes:` frontmatter list REPLACES
 * the derived set rather than adding to it — a human who names the files a
 * page covers is correcting the derivation, not supplementing it.
 */
export type DescribesOrigin = "frontmatter" | "related-code" | "key-files";

export type WikiPageNode = {
  /** "wiki:<wiki-relative path>", e.g. "wiki:components/src-ctx.md". */
  id: string;
  /** Wiki-relative path, e.g. "components/src-ctx.md". */
  path: string;
  title: string;
  /** `WikiPageType` as a plain string; the wiki owns that union. */
  pageType: string;
  status: string | null;
  version: string | null;
  /**
   * True when no describe pattern resolved to a known file. Such a page
   * cannot be scored for freshness — which is NOT the same as being fresh,
   * and NOT the same as being orphaned (specification §4.4.1).
   */
  undecidable: boolean;
};

export type DescribesEdge = {
  id: string;
  /** `WikiPageNode.id`. */
  from: string;
  /** A file `GraphNode.path` — the layer only ever points at known files. */
  to: string;
  /** The pattern that produced this edge, as written or derived. */
  pattern: string;
  origin: DescribesOrigin;
};

export type WikiLayer = {
  pages: WikiPageNode[];
  describes: DescribesEdge[];
};

/**
 * Per-file content fingerprint (LWG-2), written to
 * `storage/build-manifest.json`. Kept out of `GraphNode` so `nodes.jsonl`
 * stays byte-stable for its existing consumers; the incremental rebuild
 * (LWG-3, phase 4) is the intended reader.
 */
export type FileFingerprint = {
  path: string;
  /** sha256 of the file's content at build time. */
  contentHash: string;
  mtimeMs: number;
};
