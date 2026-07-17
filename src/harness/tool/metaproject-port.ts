// Typed, in-process MetaprojectPort (flow 037 / MP-1).
//
// A content-returning, DETERMINISTIC read port over keryx's metaproject layer:
// code search, graph blast-radius + queries, project memory, wiki pages, and a
// context summary. It is a PURE type/interface module — no imports with side
// effects, no runtime logic — so it can be depended on from anywhere (the harness
// tool factory, the agent, MCP) without pulling in a backing implementation.
//
// Result shapes are aligned with the docpack schemas under
// docs/requirements/keryx-metaproject-native/schemas/ (graph-affected-result and
// memory-search-result in particular). A reference implementation lives in
// metaproject-adapter.ts (`createMetaprojectAdapter`); consumers depend only on
// the interface here.

/** One transitive dependent (blast-radius) node — graph-affected-result.schema.json. */
export interface GraphAffectedNode {
  /** Node id (file path or symbol id). */
  id: string;
  /** File path when the node is a file. */
  path?: string;
  /** Distance in dependency hops from the target (>= 1). */
  hop: number;
  /** Incoming edge count (used for ranking). */
  fanIn?: number;
}

/** Structured result of `graphAffected` — graph-affected-result.schema.json. */
export interface GraphAffectedResult {
  /** The file or symbol whose dependents were computed. */
  target: string;
  /** Max hop depth traversed. */
  depth?: number;
  /** Whether entries are ranked (hop asc, then fanIn desc, then path asc). */
  ranked?: boolean;
  /** Dependent nodes. */
  affected: GraphAffectedNode[];
  /** True when the result was capped by an output bound. */
  truncated?: boolean;
  /** Set when the backing service failed — the result is structured-empty, not thrown. */
  error?: string;
}

/** Structured result of `graphQuery` (cycles or orphans). */
export interface GraphQueryResult {
  /** Which query was run. */
  query: "cycles" | "orphans";
  /** Orphan file paths (present when `query === "orphans"`). */
  orphans?: string[];
  /** Cycles as ordered path lists (present when `query === "cycles"`). */
  cycles?: string[][];
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** One ranked project-memory hit — memory-search-result.schema.json. */
export interface MemorySearchHit {
  /** Memory entry file path under .metaproject/memory/. */
  path: string;
  title: string;
  /** Memory type (lesson, decision, constraint, known-mistake, …). */
  type?: string;
  /** Entry status. */
  status?: string;
  /** Deterministic rank score (higher = more relevant). */
  score: number;
  /** Bounded snippet of the entry body. */
  excerpt?: string;
}

/** Applied memory-search filters (all optional) — memory-search-result.schema.json. */
export interface MemorySearchFilters {
  module?: string;
  status?: string;
}

/** Structured result of `memorySearch` — memory-search-result.schema.json. */
export interface MemorySearchResult {
  /** The search query. */
  query: string;
  /** Applied filters (all optional). */
  filters?: MemorySearchFilters;
  /** Ranked memory entries. */
  hits: MemorySearchHit[];
  /** Set when the backing service failed — structured-empty, not thrown. */
  error?: string;
}

/** Structured result of `searchCode`. */
export interface SearchCodeResult {
  /** The search pattern. */
  pattern: string;
  /** The path scope (relative to the project root), when provided. */
  path?: string;
  /** Bounded, rendered search output (compact ripgrep text). */
  output: string;
  /** True when the search itself failed. */
  isError: boolean;
  /** True when the result was capped by an output bound. */
  truncated?: boolean;
}

/** Structured result of `readWiki`. */
export interface WikiPageResult {
  /** The requested wiki path (relative to .metaproject/wiki/). */
  path: string;
  /** The page content, or "" when unavailable. */
  content: string;
  /** True when the path escaped the wiki root or the file could not be read. */
  isError: boolean;
  /** Set with a human-readable reason when `isError` is true. */
  error?: string;
}

/** Structured result of `describeContext` — a lightweight project summary. */
export interface ContextSummaryResult {
  /** The project root the port is bound to. */
  root: string;
  /** Graph node count (0 when the graph is unavailable). */
  graphNodes: number;
  /** Graph edge count (0 when the graph is unavailable). */
  graphEdges: number;
  /** Whether a wiki index (.metaproject/wiki/index.md) is present. */
  hasWikiIndex: boolean;
  /** Set when the summary could not be fully computed (partial/degraded). */
  error?: string;
}

/**
 * A content-returning, deterministic read port over the metaproject layer. Every
 * method returns a structured result and NEVER throws — a backing failure becomes
 * a structured empty/error result (see each result type's `error`/`isError`).
 */
export interface MetaprojectPort {
  searchCode(input: { pattern: string; path?: string }): Promise<SearchCodeResult>;
  graphAffected(input: { target: string; depth?: number; ranked?: boolean }): Promise<GraphAffectedResult>;
  graphQuery(input: { query: "cycles" | "orphans" }): Promise<GraphQueryResult>;
  memorySearch(input: {
    query: string;
    module?: string;
    status?: string;
    limit?: number;
  }): Promise<MemorySearchResult>;
  readWiki(input: { path: string }): Promise<WikiPageResult>;
  describeContext(): Promise<ContextSummaryResult>;
}
