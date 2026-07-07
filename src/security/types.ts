// Core type surface for Metaproject Security.
//
// Mirrors the in-process service contract (specification.md §6a) and the
// security-finding / security-report JSON schemas (§8/§9). These types are the
// contract other modules program against; keep them in sync with schemas.ts.

export type SecuritySource =
  | "trusted-project"
  | "trusted-user"
  | "untrusted-external"
  | "tool-output"
  | "generated";

export type SecurityTarget =
  | "model"
  | "memory"
  | "wiki"
  | "report"
  | "external"
  | "task"
  | "unknown";

export type SecurityAction =
  | "allow"
  | "redact"
  | "block"
  | "require-approval"
  | "warn";

export type SecurityGate = "pass" | "needs-approval" | "fail";

export type SecuritySeverity = "critical" | "high" | "medium" | "low" | "info";

export type SecurityCategory =
  | "secret"
  | "pii"
  | "prompt-injection"
  | "egress"
  | "artifact-safety"
  | "raw-retention";

export type SecurityMode = "advisory" | "enforced" | "ci" | "gateway";

export type RawRetention = "off" | "local" | "ci-private" | "explicit";

// A source reference embedded in a finding (security-finding.schema.json).
export type SecuritySourceRef = {
  kind: SecuritySource;
  path?: string;
  command?: string;
  url?: string;
};

export type SecurityLocation = {
  line?: number;
  column?: number;
  start?: number;
  end?: number;
};

// Committable finding shape (security-finding.schema.json). `hash`, when present,
// is HMAC-keyed (§10a) and is stripped before an artifact is written to disk.
export type SecurityFinding = {
  id: string;
  policyId: string;
  severity: SecuritySeverity;
  category: SecurityCategory;
  source: SecuritySourceRef;
  target?: SecurityTarget;
  action: SecurityAction;
  confidence: number;
  redactedPreview?: string;
  hash?: string;
  location?: SecurityLocation;
  remediation?: string;
  createdAt: string;
};

export type SecurityCheck = {
  content: string;
  source: SecuritySource;
  target?: SecurityTarget;
  path?: string;
};

export type SecurityDecision = {
  gate: SecurityGate;
  action: SecurityAction; // strongest applied action
  findings: SecurityFinding[];
  redacted?: string; // present when a redactable finding was applied
};

export type SecurityReportSummary = {
  total: number;
  bySeverity: Record<string, number>;
  byAction: Record<string, number>;
  byCategory: Record<string, number>;
};

export type SecurityReport = {
  schemaVersion: number;
  createdAt: string;
  mode: SecurityMode;
  gate: SecurityGate;
  rawRetention: RawRetention;
  summary: SecurityReportSummary;
  findings: SecurityFinding[];
  integrations?: Record<string, unknown>;
};

export type PolicyConfig = {
  enabled: boolean;
  action: SecurityAction;
  minConfidence?: number;
};

export type SecurityConfig = {
  schemaVersion: number;
  mode: SecurityMode;
  rawRetention: RawRetention;
  storeHashes: boolean;
  storeRedactedSamples: boolean;
  policies: {
    secrets: PolicyConfig;
    pii: PolicyConfig;
    promptInjection: PolicyConfig;
    egress: PolicyConfig;
    artifactSafety: PolicyConfig;
  };
  backends: {
    rules: { enabled: boolean };
    entropy: { enabled: boolean };
    piiModel: { enabled: boolean; provider: string };
    externalApi: { enabled: boolean };
  };
  gate: { failOn: SecuritySeverity; minConfidence: number };
  configChecksum?: string;
};

// Internal detector output. Carries the raw sensitive `value` so redaction and
// HMAC hashing can run downstream; the raw value NEVER reaches a finding or a
// committable artifact. `mask`, when set, marks the span as redactable and names
// the typed mask to substitute (e.g. "secret", "email").
export type DetectorMatch = {
  category: SecurityCategory;
  policyId: string;
  severity: SecuritySeverity;
  confidence: number;
  start: number;
  end: number;
  value: string;
  mask?: string;
  remediation?: string;
};

// Incident trail entry (§14).
export type IncidentEntry = {
  at: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
};

export type SecurityService = {
  check(input: SecurityCheck): Promise<SecurityDecision>;
  redact(
    content: string,
    opts?: { source?: SecuritySource },
  ): Promise<{ redacted: string; findings: SecurityFinding[] }>;
  report(input: { cwd: string; since?: string }): Promise<SecurityReport>;
  gate(input: {
    cwd: string;
  }): Promise<{ status: "pass" | "fail"; reasons: string[] }>;
};
