// Core type surface for Metaproject Security.
//
// Mirrors the in-process service contract (specification.md §6a) and the
// security-finding / security-report JSON schemas (§8/§9). These types are the
// contract other modules program against; keep them in sync with schemas.ts.

/**
 * WHERE a piece of content came from, which is what decides how far it is
 * trusted. Five members, and the set is closed — a caller picks the one that
 * describes the content's real provenance, never the one whose policy it wants.
 *
 * Documented here because they were not documented anywhere, and a round of
 * review found prose that named four of them and described one wrongly.
 *
 *   trusted-project     content already in the repository the operator chose to
 *                       work in — source, docs, committed config. Trusted
 *                       because the operator vetted it by committing it, NOT
 *                       because keryx produced it. `keryx security scan`
 *                       defaults to this, and `ctx` uses it for a FILE read off
 *                       disk. Not for command output — `ctx` tags that
 *                       `tool-output`, and an earlier version of this line sent
 *                       a reader to the wrong one of the five in a docstring
 *                       whose whole job is choosing between them.
 *
 *   trusted-user        typed by the operator at their own terminal, in this
 *                       session. The one source with a human behind it in real
 *                       time, which is why it is separate from the one above:
 *                       nobody committed it and nobody reviewed it, but the
 *                       person who wrote it is the person being protected.
 *
 *   untrusted-external  arrived from outside the operator's machine — a remote
 *                       turn's prompt, a fetched document, an agent hook's
 *                       stdin. The strictest posture, and the reason
 *                       `scanPrompt` names it explicitly.
 *
 *   tool-output         produced by a tool keryx invoked. Untrusted for the
 *                       same reason as the above without being remote: a tool
 *                       can read attacker-controlled bytes and hand them back.
 *
 *   generated           produced by a model in this process, including every
 *                       `assistant.delta` before it is appended. This is the
 *                       one that means "keryx produced it".
 */
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
  | "skill"
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
  // Egress-only (Block E, E3): deny-by-default host allowlist. Present ONLY when
  // a user configures it — an absent/empty allowlist preserves the shipped
  // send-verb proximity behavior byte-for-byte (AC2.3). When non-empty it is
  // covered by `configChecksum` so tampering is detected.
  allowlist?: string[];
};

// Block E (E1): opt-in semantic injection backend on the shipped `backends`
// seam. Default off ⇒ deterministic regex path only, no dep, no asset (AC1.1).
export type InjectionModelBackend = {
  enabled: boolean;
  provider: string; // "prompt-guard-2"
  size: string; // "22M" | "86M"
  assetId: string; // resolved via Block 0 assets.lock.json
  minConfidence: number;
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
    // Block E (E4-NER): `assetId` wires the optional NER PII backend to a Block 0
    // asset. Default off ⇒ deterministic PII only (AC4.3).
    piiModel: { enabled: boolean; provider: string; assetId?: string };
    externalApi: { enabled: boolean };
    injectionModel?: InjectionModelBackend;
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
