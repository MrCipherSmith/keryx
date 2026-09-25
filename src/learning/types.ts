// Type surface for the self-learning loop (W3), core of `src/learning/`.
//
// Mirrors `learned-pattern.schema.json` field-for-field (`schema.ts` is the
// hand-written runtime validator over these types; keep both in sync with the
// docs schema copy). `ObservationEvent` mirrors the "Observation event
// contract" table in the W3 spec, plus the optional hash-only `edit` field
// added by plan decision D3 (v0.1.4 amendment, never raw content).

export type LearningDomain =
  | "code-style"
  | "architecture"
  | "testing"
  | "security"
  | "review-conventions"
  | "workflow"
  | "documentation"
  | "performance"
  | "tooling"
  | "other";

export type LearningStatus = "candidate" | "accepted" | "rejected" | "superseded" | "expired";

export type LearningScope = "project" | "user";

export type EvidenceKind = "reinforcement" | "contradiction";

export type EvidenceSourceType =
  | "review"
  | "test"
  | "failure"
  | "health"
  | "memory"
  | "observation"
  | "reviewer-comment";

export interface EvidenceItem {
  kind: EvidenceKind;
  sourceType: EvidenceSourceType;
  /** Path (relative to the project root) to the artifact that produced this item — never raw quoted source text. */
  sourceRef: string;
  observedAt: string;
  /** Defaults to 1.0 when absent. Clamped to [0, MAX_EVIDENCE_WEIGHT] by `confidence.ts`. */
  weight?: number;
}

export type ProjectIdentityKind = "remote-hash" | "path-hash";

export interface ProjectIdentity {
  /** sha256 hex of the normalized remote URL, or of the resolved worktree root path (path-hash fallback). */
  identity: string;
  identityKind: ProjectIdentityKind;
  /** Review-UI-only label; never used for identity comparison or dedup. */
  displayName?: string;
}

export type ConfidenceLevel = "low" | "medium" | "high";

export interface ReviewerProfile {
  /** Opaque per-project identifier for the configured comment author — never the literal login. */
  reviewerId: string;
  /** Count of distinct source comments generalized into this record's trigger/action text. */
  generalizedFrom: number;
}

export interface Redaction {
  /** Always true for a stored record — a non-true scan result means the record was refused before reaching the store. */
  scanned: true;
  /** Category names only (e.g. "secret", "prompt-injection"), never the matched text. */
  findings: string[];
}

export type GraduationTarget = "skill" | "agent" | "rule";

export interface Graduation {
  target: GraduationTarget;
  proposalPath: string;
}

export type ExtractorKind = "deterministic" | "model-backed";

export interface Provenance {
  extractor: string;
  extractorKind?: ExtractorKind;
  /**
   * Present only on a record that arrived via `keryx bundle import`
   * (R700-11) — records where this bundle's rewrite last touched the
   * record, distinct from `extractor`/`extractorKind`, which describe how
   * the pattern was originally mined, not how it got into THIS project.
   * Optional so pre-existing records (mined locally, never imported) still
   * validate without it.
   */
  importedFrom?: {
    bundleId: string;
    /** ISO 8601 date-time of this import, not of the original export. */
    importedAt: string;
    /** The record's `confidence` before the import-time cap was applied, for audit only — never used to restore it. */
    originalConfidence?: number;
  };
}

export interface LearningTtl {
  expiresAt: string;
}

/** A candidate/accepted/rejected/superseded/expired self-learned pattern. See `learned-pattern.schema.json`. */
export interface LearnedPattern {
  schemaVersion: 1;
  /** Deterministic slug (domain + normalized trigger text), never random. */
  id: string;
  trigger: string;
  action: string;
  domain: LearningDomain;
  scope: LearningScope;
  project: ProjectIdentity;
  confidence: number;
  /** Derived, never authored directly — recomputed from `confidence` on every update. */
  confidenceLevel?: ConfidenceLevel;
  status: LearningStatus;
  /** Required (non-null) when `status === "superseded"`; null otherwise. */
  supersededBy?: string | null;
  evidence: EvidenceItem[];
  /** Non-null only for `domain: "review-conventions"` records; null otherwise. */
  reviewerProfile?: ReviewerProfile | null;
  redaction: Redaction;
  /** Null until a cluster containing this record produced a graduation proposal. */
  graduation?: Graduation | null;
  provenance: Provenance;
  /** Required when `status === "candidate"`; absent otherwise. */
  ttl?: LearningTtl;
  createdAt: string;
  updatedAt: string;
}

export type ObservationEventName =
  | "tool-start"
  | "tool-complete"
  | "tool-failed"
  | "user-prompt"
  | "session-start"
  | "turn-stop"
  | "session-end";

/** Same `{ identity, identityKind }` shape as `LearnedPattern.project`, without `displayName`. */
export interface ObservationProjectIdentity {
  identity: string;
  identityKind: ProjectIdentityKind;
}

/**
 * One JSON-lines record appended under
 * `.metaproject/data/learning/observations/<YYYY-MM-DD>.jsonl`. Field-for-field
 * mirror of the W3 spec's "Observation event contract" table, plus the
 * optional hash-only `edit` field (plan decision D3): never stores raw diff
 * content, only digests, so reverted-edit / repeated-correction are
 * detectable without carrying transcript text.
 */
export interface ObservationEvent {
  schemaVersion: 1;
  event: ObservationEventName;
  /** Present for tool-* events; null otherwise. */
  tool: string | null;
  /** sha256 of the tool input — never the raw input. */
  inputDigest: string;
  /** First 200 chars of the (redacted) tool input. */
  inputPreview: string;
  /** Same bound and redaction as `inputPreview`; present only for tool-complete/tool-failed. */
  outputPreview: string | null;
  sessionId: string;
  toolUseId: string | null;
  /** sha256 of the resolved cwd — never the raw path. */
  cwdHash: string;
  project: ObservationProjectIdentity;
  observedAt: string;
  /** Hash-only edit shape (D3): never raw diff content. */
  edit?: {
    pathDigest: string;
    removedDigest: string | null;
    addedDigest: string | null;
  } | null;
}

/** One project's accept-time entry in `~/.keryx/learning/index.json`, keyed by pattern `id`. */
export interface IndexEntry {
  projectIdentity: string;
  identityKind: ProjectIdentityKind;
  /** Accept-time snapshot — never updated by later reinforcement/decay; refreshed only by `keryx learn accept --refresh`. */
  confidence: number;
  acceptedAt: string;
}

/** `~/.keryx/learning/index.json` — pattern id to one entry per distinct `project.identity`. */
export type LearningIndex = Record<string, IndexEntry[]>;
