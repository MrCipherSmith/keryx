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
};

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
};

export type SearchFilters = {
  module?: string | undefined;
  entity?: string | undefined;
  status?: MemoryStatus | undefined;
  limit?: number | undefined;
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

export type MemoryIndexInput = { cwd: string };
export type MemoryIndexResult = {
  path: string;
  entryCount: number;
  generatedAt: string;
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
  check(input: MemoryCheckInput): Promise<MemoryCheckResult>;
}
