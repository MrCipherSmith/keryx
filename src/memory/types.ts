export type MemoryStatus =
  | "draft"
  | "accepted"
  | "deprecated"
  | "conflict"
  | "superseded";

export type Confidence = "low" | "medium" | "high";

export type MemoryTypeConfig = {
  type: string;
  folder: string;
  template: boolean; // has an MVP template / is a first-class new-able type
};

export const MEMORY_TYPES: MemoryTypeConfig[] = [
  { type: "lesson", folder: "lessons", template: true },
  { type: "decision", folder: "decisions", template: true },
  { type: "constraint", folder: "constraints", template: true },
  { type: "known-mistake", folder: "known-mistakes", template: true },
  { type: "historical-context", folder: "historical-context", template: false },
  { type: "pattern", folder: "patterns", template: false },
  { type: "task-note", folder: "task-notes", template: false },
  { type: "review-note", folder: "review-notes", template: false },
  { type: "incident", folder: "incidents", template: false },
  { type: "migration-note", folder: "migration-notes", template: false },
  { type: "integration-note", folder: "integration-notes", template: false },
];

export const MEMORY_TYPE_VALUES = MEMORY_TYPES.map((entry) => entry.type);

// C3 — knowledge class. Every MEMORY_TYPES kind maps to exactly one of these.
export type MemoryClass = "semantic" | "episodic" | "procedural";

export const MEMORY_CLASS_VALUES: readonly MemoryClass[] = [
  "semantic",
  "episodic",
  "procedural",
];

// Total, single-class coverage of every MEMORY_TYPES kind (AC-C7). An
// exhaustiveness test over MEMORY_TYPE_VALUES asserts this map stays total.
//   semantic   — stable facts/what-is-true (decisions, constraints, context)
//   procedural — how-to/repeatable guidance (patterns, mistakes, notes)
//   episodic   — time-stamped events/observations (lessons, incidents, notes)
export const MEMORY_CLASS_MAP: Record<string, MemoryClass> = {
  decision: "semantic",
  constraint: "semantic",
  "historical-context": "semantic",
  pattern: "procedural",
  "known-mistake": "procedural",
  "migration-note": "procedural",
  "integration-note": "procedural",
  lesson: "episodic",
  "task-note": "episodic",
  "review-note": "episodic",
  incident: "episodic",
};

// The class of a kind, defaulting to "semantic" for an unknown/legacy kind so
// resolution is total even for entries whose folder type is not in the map.
export function classForType(type: string): MemoryClass {
  return MEMORY_CLASS_MAP[type] ?? "semantic";
}

export type MemoryScopes = {
  module: string | null;
  entity: string | null;
  files: string[];
  skills: string[];
};

export type MemoryEntry = {
  absolutePath: string;
  relativePath: string; // relative to the memory root, e.g. lessons/foo.md
  type: string;
  title: string;
  version: string | null;
  status: MemoryStatus;
  confidence: Confidence;
  summary: string;
  details: string;
  tags: string[];
  scopes: MemoryScopes;
  created: string | null;
  updated: string | null;
  provenance: { source: string | null; link: string | null };
  // --- C2/C3 bitemporal + class fields (optional; absent ⇒ null / mapped
  // class). Back-compatible: entries authored before Block C omit these header
  // fields and parse exactly as before. `classForType(entry.type)` is the
  // resolved class when `class` is absent. ---
  class?: MemoryClass | undefined;
  validFrom?: string | null | undefined; // event-time start (YYYY-MM-DD)
  validTo?: string | null | undefined; // event-time end (empty ⇒ open/current)
  recordedAt?: string | null | undefined; // ingestion-time
  supersedes?: string | null | undefined; // relativePath this entry replaces
  supersededBy?: string | null | undefined; // relativePath that replaced this
};

// The resolved class of an entry: its explicit `class` header when present,
// else the class mapped from its `type` (AC-C7). Always total.
export function memoryClassOf(entry: MemoryEntry): MemoryClass {
  return entry.class ?? classForType(entry.type);
}

export type MemoryConfig = {
  schemaVersion: number;
  ranking: {
    weights: {
      relevance: number;
      recency: number;
      confidence: number;
      status: number;
      scope: number;
    };
    recencyDecayPerDay: number;
    maxResults: number;
  };
  confidence: { default: Confidence; values: Record<Confidence, number> };
  statusBoost: Record<MemoryStatus, number>;
  dedup: {
    titleSimilarity: number;
    summaryJaccard: number;
    minSharedScopeOrTags: number;
  };
  ingest: { defaultStatus: MemoryStatus; allowAutoAccept: boolean };
  reflect: { minClusterSize: number };
  // --- C1 embedding index (opt-in ceiling; default OFF ⇒ lexical only). ---
  index: {
    enabled: boolean;
    runtime: string; // named reference; imported lazily by the adapter only
    modelAssetId: string; // resolved via the Asset Resolver
    k: number; // candidate pool reranked
    minScore: number;
  };
  // --- C2 bitemporal. ---
  temporal: {
    enabled: boolean;
    defaultQuery: "current" | "as-of";
  };
  // --- C3 typing / procedural injection. ---
  typing: {
    injectClasses: MemoryClass[];
    injectLimit: number;
  };
};

export type SearchFilters = {
  module?: string | undefined;
  entity?: string | undefined;
  status?: MemoryStatus | undefined;
  limit?: number | undefined;
  // C2: validity-interval query (YYYY-MM-DD). Overrides the default `current`
  // exclusion; returns entries whose validity interval contains this date.
  asOf?: string | undefined;
  // C5: restrict to a single knowledge class before scoring.
  class?: MemoryClass | undefined;
  // C1: opt into the embedding rerank of the lexical candidate set.
  semantic?: boolean | undefined;
};

export type ScoredEntry = {
  entry: MemoryEntry;
  score: number;
  components: {
    relevance: number;
    recency: number;
    confidence: number;
    status: number;
    scope: number;
  };
  reason: string;
};

export type DuplicateHint = {
  path: string;
  title: string;
  titleSimilarity: number;
  summaryJaccard: number;
};

export type ConflictHint = {
  path: string;
  title: string;
  reason: string;
};

// --- Service contract ---

export type MemoryCreateInput = {
  cwd: string;
  type: string;
  slug?: string | undefined;
  title?: string | undefined;
  force?: boolean | undefined;
};
export type MemoryCreateResult = {
  path: string;
  type: string;
  duplicates: DuplicateHint[];
};

export type MemoryIndexInput = { cwd: string; embeddings?: boolean | undefined };
export type MemoryIndexResult = {
  path: string;
  entryCount: number;
  generatedAt: string;
  // Set when `embeddings` was requested: the derived embedding index outcome.
  embeddings?:
    | {
        built: boolean; // false ⇒ capability unavailable, lexical index only
        path?: string | undefined;
        vectorCount?: number | undefined;
        model?: string | undefined;
      }
    | undefined;
};

export type MemorySearchInput = {
  cwd: string;
  query: string;
  filters?: SearchFilters | undefined;
};
export type MemorySearchResult = {
  schemaVersion: number;
  query: string;
  results: ScoredEntry[];
  markdownPath: string;
  jsonPath: string;
};

export type MemoryIngestInput = {
  cwd: string;
  source: string; // review|health|job|skill-verifier
  path: string;
};
export type MemoryIngestResult = {
  created: string[];
  reconciled: string[];
  skippedDuplicates: number;
  conflicts: ConflictHint[];
  // Advisory-mode security findings surfaced for accepted entries (leak-safe,
  // category+count only). Present only when the security seam produced warnings.
  securityWarnings?: string[];
  // Entries whose write was suppressed by the security gate in enforced/ci mode.
  securitySkipped?: Array<{ title: string; reason: string }>;
};

export type MemorySupersedeInput = {
  cwd: string;
  oldPath: string; // memory-root-relative or cwd-relative path of the superseded entry
  newPath: string; // path of the superseding entry
  date?: string | undefined; // event-time boundary; defaults to today
};
export type MemorySupersedeResult = {
  superseded: string; // relativePath of the old entry
  supersededBy: string; // relativePath of the new entry
  changed: boolean; // false ⇒ already superseded (idempotent no-op)
  // Set when the security gate suppressed a write (enforced/ci mode).
  securitySkipped?: string | undefined;
};

export type MemoryCheckInput = { cwd: string };
export type MemoryCheckIssue = {
  path: string;
  kind: "metadata" | "version" | "link" | "dedup" | "conflict" | "index";
  message: string;
};
export type MemoryCheckResult = { ok: boolean; issues: MemoryCheckIssue[] };

export interface MemoryService {
  create(input: MemoryCreateInput): Promise<MemoryCreateResult>;
  index(input: MemoryIndexInput): Promise<MemoryIndexResult>;
  search(input: MemorySearchInput): Promise<MemorySearchResult>;
  ingest(input: MemoryIngestInput): Promise<MemoryIngestResult>;
  supersede(input: MemorySupersedeInput): Promise<MemorySupersedeResult>;
  check(input: MemoryCheckInput): Promise<MemoryCheckResult>;
}
