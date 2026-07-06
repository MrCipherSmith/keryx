export type Severity = "error" | "warning" | "info";
export type Priority = "P0" | "P1" | "P2" | "P3";

export type SourceId =
  | "eslint"
  | "typescript"
  | "tests"
  | "coverage"
  | "dependencyAudit"
  | "sonarqube"
  | "complexity";

export type SourceMode = "auto" | "run" | "import" | "disabled";
export type SourceStatus =
  | "available"
  | "missing"
  | "configured-but-failed"
  | "skipped";

export type SourceConfig = { mode: SourceMode; required: boolean };

export type HealthConfig = {
  schemaVersion: number;
  sources: Record<string, SourceConfig>;
  metrics: {
    coverageTarget: number;
    coverageSoftFloor: number;
    complexityThreshold: number;
    churnWindowDays: number;
  };
  scoring: {
    priorityWeights: Record<Priority, number>;
    coverageWeight: number;
    complexityWeight: number;
    normalizePerLoc: number;
  };
  gate: {
    failOnPriorities: Priority[];
    failOnRegressionDrop: number;
    warnOnRegressionDrop: number;
    failOnMissingRequiredSource: boolean;
  };
};

export type FindingScope = {
  project: string;
  module: string | null;
  file: string | null;
  entity: string | null;
  skill: string | null;
};

export type Finding = {
  schemaVersion: number;
  id: string;
  source: string;
  severity: Severity;
  priority: Priority;
  category: string;
  message: string;
  file: string | null;
  line: number | null;
  symbol: string | null;
  scope: FindingScope;
  suggestedAction: string | null;
  provenance: {
    command: string | null;
    toolVersion: string | null;
    rawLog: string | null;
  };
};

export type RawSourceResult = {
  source: string;
  command: string | null;
  toolVersion: string | null;
  exitCode: number | null;
  rawPath: string;
  content: string;
  imported: boolean;
};

export type ScopeKind = "project" | "module" | "file";

export type ScopeMetrics = {
  key: string;
  kind: ScopeKind;
  name: string;
  loc: number;
  findingCounts: {
    total: number;
    bySeverity: Record<Severity, number>;
    byPriority: Record<Priority, number>;
    bySource: Record<string, number>;
  };
  coverage: number | null;
  churn: number | null;
  complexity: { max: number; aboveThreshold: number } | null;
  health_score: number;
  risk_score: number;
  trend: "improved" | "stable" | "regressed" | "unknown";
  regression_score: number;
};

export type GateStatus = "pass" | "warn" | "fail";
export type GateResult = { status: GateStatus; reasons: string[] };

export type SourceRunInfo = {
  source: string;
  status: SourceStatus;
  mode: SourceMode;
  required: boolean;
  imported: boolean;
  command: string | null;
  toolVersion: string | null;
  findings: number;
  error?: string;
};

export type HealthReport = {
  schemaVersion: number;
  generatedAt: string;
  scope: string;
  strict: boolean;
  gitRef: string | null;
  gate: GateResult;
  sources: SourceRunInfo[];
  metrics: ScopeMetrics[];
  findings: Finding[];
};

export type ScopeSelector =
  | { kind: "project" }
  | { kind: "module"; name: string }
  | { kind: "file"; path: string }
  | { kind: "changed"; since: string | null };

export type HealthContext = {
  cwd: string;
  config: HealthConfig;
  strict: boolean;
  scopeSelector: ScopeSelector;
  changedFiles: string[] | null;
  sourceFiles: string[];
  moduleOf: (file: string) => string | null;
};

export interface SourceAdapter {
  id: SourceId;
  detect(ctx: HealthContext): Promise<SourceStatus>;
  run(ctx: HealthContext): Promise<RawSourceResult>;
  import(ctx: HealthContext): Promise<RawSourceResult>;
  parse(raw: RawSourceResult, ctx: HealthContext): Finding[];
}

export type HealthRunInput = {
  cwd: string;
  scope?: ScopeSelector;
  strict?: boolean;
  sources?: string[];
};
export type HealthRunResult = {
  report: HealthReport;
  markdownPath: string;
  jsonPath: string;
};

export type HealthStatusInput = { cwd: string };
export type HealthStatusResult = {
  enabled: boolean;
  lastRunAt: string | null;
  gate: GateStatus | null;
  sources: Array<{ source: string; status: SourceStatus }>;
  projectScore: number | null;
  regressions: number;
};

export type HealthGateInput = { cwd: string; strictWarn?: boolean };
export type HealthGateResult = { status: GateStatus; exitCode: number; reasons: string[] };

export type HealthSourcesInput = { cwd: string };
export type HealthSourcesResult = {
  sources: Array<{
    source: string;
    mode: SourceMode;
    required: boolean;
    status: SourceStatus;
  }>;
};

export type HealthExplainInput = { cwd: string; target: string };
export type HealthExplainResult = {
  target: string;
  found: boolean;
  metrics: ScopeMetrics | null;
  findings: Finding[];
};

export type HealthBaselineInput = { cwd: string; scope?: ScopeSelector };
export type HealthBaselineResult = { updated: string[]; path: string };

export interface CodeHealthService {
  run(input: HealthRunInput): Promise<HealthRunResult>;
  status(input: HealthStatusInput): Promise<HealthStatusResult>;
  gate(input: HealthGateInput): Promise<HealthGateResult>;
  sources(input: HealthSourcesInput): Promise<HealthSourcesResult>;
  explain(input: HealthExplainInput): Promise<HealthExplainResult>;
  updateBaseline(input: HealthBaselineInput): Promise<HealthBaselineResult>;
}
