export type TestingStatus = "pass" | "fail" | "error" | "skipped";
export type TestingFallbackWhenEmpty = "warn" | "full" | "skipped" | "fail";

export type TestingScript = {
  name: string;
  command: string;
};

export type TestingContext = {
  schemaVersion: 1;
  generatedAt: string;
  frameworks: string[];
  scripts: TestingScript[];
  configs: string[];
  testFiles: string[];
  ciFiles: string[];
  instructionFiles: string[];
  conventions: string[];
  recommendations: string[];
};

export type TestingFailure = {
  file: string | null;
  name: string;
  message: string;
  priority: "P0";
};

export type TestingReport = {
  schemaVersion: 1;
  generatedAt: string;
  gitRef: string | null;
  status: TestingStatus;
  scope: string;
  runner: string | null;
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  };
  selection: {
    changed: boolean;
    strategies: string[];
    selectedTests: string[];
    changedFiles: string[];
    fallback: "none" | "warn" | "full" | "skipped";
    // D3: always-on smoke tier unioned into every selection mode. Empty by
    // default ⇒ a no-op union (byte-identical selection behavior).
    smokeTests: string[];
  };
  failures: TestingFailure[];
  relatedFiles: string[];
  relatedSkills: string[];
  rawLogPath: string | null;
  runId?: string;
  provenance?: {
    commit: string | null;
    branch: string | null;
    worktree: string | null;
    sources: Array<{
      name: string;
      path: string | null;
      timestamp: string | null;
      reliability: "exact" | "estimated" | "unknown";
    }>;
  };
};

export type TestingRunInput = {
  cwd: string;
  changed?: boolean;
  since?: string | null;
  scope?: string | null;
  kind?: string | null;
  strict?: boolean;
  runId?: string;
  provenance?: TestingReport["provenance"];
};

// D2: coverage-map source. `import` parses an existing report without running
// tests; `lcov`/`v8` build by running the suite with coverage; `auto` picks.
export type CoverageMapSource = "auto" | "lcov" | "v8" | "import";

// D2: normalized, deterministic coverage map (`testFile → covered files/lines`).
// Git-diffable; re-building the same inputs yields an identical file.
export type CoverageMapEntry = {
  coveredFiles: string[];
  coveredLines?: Record<string, number[]>;
};
export type CoverageMap = {
  schemaVersion: 1;
  generatedAt: string;
  gitRef: string | null;
  map: Record<string, CoverageMapEntry>;
};

export type TestingConfig = {
  schemaVersion: number;
  enabled: boolean;
  runner: "auto" | "script" | "direct";
  changedSelection: {
    strategies: string[];
    fallbackWhenEmpty: TestingFallbackWhenEmpty;
  };
  // D2: coverage-map Test Impact Analysis. Default OFF ⇒ static fallback
  // (byte-identical). Deep-merged over defaults; malformed JSON ⇒ defaults.
  coverageMap: {
    enabled: boolean;
    source: CoverageMapSource;
    path: string;
    artifact: string;
    lineGranularity: boolean;
  };
  // D3: always-on smoke tier. Empty selectors ⇒ no smoke ⇒ byte-identical.
  smoke: {
    selectors: string[];
  };
  hooks: {
    postCommitRefresh: boolean;
    prePushGate: boolean;
  };
  artifacts: {
    keepRawLogs: boolean;
    historyLimit: number;
  };
};

export type TestingRunResult = {
  report: TestingReport;
  markdownPath: string;
  jsonPath: string;
  // Leak-safe security notes from the write seam. In advisory mode these are
  // informational; in enforced/ci mode they include suppressed raw-log persistence.
  securityWarnings?: string[];
};
