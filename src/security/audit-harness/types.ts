// Flow 308 (W8 Design part A) — report types for `keryx security audit-harness`.
// Mirrors docs/requirements/keryx-agent-platform-expansion/schemas/harness-audit-report.schema.json
// field-for-field; keep the two in sync.

import type { SecuritySeverity } from "../types";

/** The report's severity vocabulary is a strict subset of `SecuritySeverity` — no `info`. */
export type AuditSeverity = Exclude<SecuritySeverity, "info">;

export type SurfaceId =
  | "instructions"
  | "settings"
  | "mcp-configs"
  | "hooks"
  | "agent-definitions"
  | "skills"
  | "imported-bundles";

export type CheckId =
  | "secret-in-instructions"
  | "prompt-injection-in-instructions"
  | "auto-run-directive"
  | "over-permissive-allowlist"
  | "missing-deny-list"
  | "bypass-flag-present"
  | "unpinned-mcp-launcher"
  | "mcp-tool-poisoning"
  | "mcp-rug-pull"
  | "hook-command-injection"
  | "hook-exfiltration-shape"
  | "hook-silent-suppression"
  | "agent-unrestricted-tools"
  | "agent-missing-model-tier"
  | "skill-script-secret"
  | "skill-script-injection"
  | "indefinite-suppression"
  // Flow 313 (W4 portability) T7: `bundle-*` variants of the checks above,
  // run against a staged W4 bundle's to-be-written content (`imported-bundles`
  // surface) before import applies anything. See W8-harness-security-audit.md
  // §Checks, `bundle-*` row.
  | "bundle-secret-in-instructions"
  | "bundle-prompt-injection-in-instructions"
  | "bundle-auto-run-directive"
  | "bundle-hook-command-injection"
  | "bundle-hook-exfiltration-shape"
  | "bundle-hook-silent-suppression"
  | "bundle-agent-unrestricted-tools"
  | "bundle-agent-missing-model-tier"
  | "bundle-skill-script-secret"
  | "bundle-skill-script-injection";

export type SurfaceScanStatus = "scanned" | "not-applicable" | "error";

export type SurfaceResult = {
  surface: SurfaceId;
  status: SurfaceScanStatus;
  pathsScanned: string[];
  pathsUnreadable?: string[];
  error?: string;
};

export type FindingLocation = {
  line?: number;
  pointer?: string;
};

export type FindingEvidence = {
  category?: string;
  policyId?: string;
  matchedToken?: string;
};

export type FixProposal = {
  id: string;
  rationale: string;
  patch?: string;
};

/**
 * A structured, machine-applicable edit for a fix proposal. Carried only on
 * the INTERNAL proposal record (see `InternalProposal`), never serialized into
 * the report — the schema's `fixProposal` carries only `{id, rationale,
 * patch}` (advisory text), so this is the shape `proposals.ts#applyAuditProposal`
 * actually executes.
 */
export type ProposalEdit =
  | { kind: "json-remove"; path: string; pointer: string }
  | { kind: "json-set"; path: string; pointer: string; value: unknown }
  | { kind: "text-replace"; path: string; from: string; to: string }
  | { kind: "manual" };

/** Internal record: the emitted `FixProposal` plus the edit `proposals.ts` applies. */
export type InternalProposal = {
  proposal: FixProposal;
  edit: ProposalEdit;
};

export type FindingSuppression = {
  value: boolean;
  baselineEntryId: string | null;
};

export type AuditFinding = {
  id: string;
  surface: SurfaceId;
  check: CheckId;
  severity: AuditSeverity;
  confidence: number;
  path?: string;
  location?: FindingLocation;
  message: string;
  evidence: FindingEvidence;
  fixProposal?: FixProposal | null;
  suppressed: FindingSuppression;
};

/**
 * A finding as produced by a check function, before an id is assigned and
 * baseline suppression is applied (`index.ts#runHarnessAudit`). `idParts` are
 * the exact ordered inputs to the deterministic id hash: surface, check, path,
 * matchedToken, and pointer-or-line (as a string).
 */
export type RawFinding = {
  surface: SurfaceId;
  check: CheckId;
  severity: AuditSeverity;
  confidence: number;
  path?: string;
  location?: FindingLocation;
  message: string;
  evidence: FindingEvidence;
  internalProposal?: InternalProposal;
};

export type Summary = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  countsBySeverity: Record<AuditSeverity, number>;
  totalFindings: number;
};

export type CoverageStatus = {
  status: "complete" | "incomplete";
  reasons?: string[];
};

export type BaselineTamperState = "ok" | "mismatch" | "unreadable";

export type BaselineEntry = {
  findingId: string;
  justification: string;
  author?: string;
  expiresAt?: string | null;
};

export type BaselineState = {
  path: string;
  tamperState: BaselineTamperState;
  entries: BaselineEntry[];
};

export type AuditCliArgs = {
  fixProposals?: boolean;
  ci?: boolean;
  baselinePath?: string | null;
  severityFloor?: AuditSeverity;
};

export type AuditReport = {
  schemaVersion: "1.0.0";
  generatedAt: string;
  root: string;
  cliArgs?: AuditCliArgs;
  surfaces: SurfaceResult[];
  findings: AuditFinding[];
  summary: Summary;
  coverage: CoverageStatus;
  baseline: BaselineState | null;
};

/**
 * Flow 313 (W4 portability) T7: the kind of a staged bundle entry, used to
 * pick which check(s) run against it — see `index.ts#scanImportedBundle`.
 */
export type ImportedBundleEntryKind = "skill" | "rule" | "agent" | "learned-pattern" | "memory-entry" | "hook-config";

export type RunAuditOptions = {
  fixProposals?: boolean;
  baselinePath?: string;
  severityFloor?: AuditSeverity;
  ci?: boolean;
  now?: () => Date;
  /**
   * Flow 313 (W4 portability) T7: a W4 bundle staged into a temp dir at its
   * to-be-written paths, with `root` pointed at that temp dir. `entries[].path`
   * is relative to `root`. Absent (the default): the `imported-bundles`
   * surface reports `not-applicable`, unchanged from before this option
   * existed. Present with an empty `entries` array: also `not-applicable`
   * (nothing to scan).
   */
  importedBundle?: { entries: ReadonlyArray<{ path: string; kind: ImportedBundleEntryKind }> };
};

export const SEVERITY_ORDER: readonly AuditSeverity[] = ["low", "medium", "high", "critical"];

export function severityRank(severity: AuditSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}
