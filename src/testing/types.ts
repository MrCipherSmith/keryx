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
  };
  failures: TestingFailure[];
  relatedFiles: string[];
  relatedSkills: string[];
  rawLogPath: string | null;
};

export type TestingRunInput = {
  cwd: string;
  changed?: boolean;
  since?: string | null;
  scope?: string | null;
  kind?: string | null;
  strict?: boolean;
};

export type TestingConfig = {
  schemaVersion: number;
  enabled: boolean;
  runner: "auto" | "script" | "direct";
  changedSelection: {
    strategies: string[];
    fallbackWhenEmpty: TestingFallbackWhenEmpty;
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
