// Evidence record types (flow 009, W7 / S4, task-R0-02).
//
// An `EvidenceRecord` is the immutable, causally-linked, provenance-tagged unit
// that lets every meaningful harness action (model request, tool call, policy
// decision, completion gate) point at a redacted, hash-addressed artifact
// instead of an unverifiable free-text claim (ADR-0001 D-01 item 6). The shape
// mirrors the frozen `evidence-record.schema.json` exactly; a constructed value
// of this type validates against that schema unchanged.
//
// Types only — no runtime, so no determinism concerns here. The redaction that
// feeds these records lives in `./redaction`.

/** Causal linkage; mirrors `harness-envelope.schema.json#/$defs/causalIds`. */
export interface EvidenceCausalIds {
  runId: string;
  sessionId: string;
  correlationId: string;
  parentEventId?: string | null;
  attemptId?: string;
  branchId?: string;
}

/** Hash-addressed artifact ref; mirrors `.../artifactRef`. */
export interface EvidenceArtifactRef {
  artifactId: string;
  kind: string;
  path?: string;
  /** Lowercase sha-256 hex (64 chars). */
  hash: string;
}

/** Trust/source provenance; mirrors `.../provenance`. */
export interface EvidenceProvenance {
  provenanceId: string;
  trustLevel: "trusted" | "untrusted" | "derived" | "unknown";
  sourceKind: string;
  sourceHash?: string;
  taintIds?: string[];
}

/** The frozen evidence `kind` enum (`evidence-record.schema.json`). */
export type EvidenceKind =
  | "context"
  | "tool-result"
  | "receipt"
  | "test"
  | "health"
  | "security"
  | "review"
  | "completion-gate"
  | "custom";

/**
 * An immutable evidence record. Structurally validates against the frozen
 * `evidence-record.schema.json` (schemaVersion always 1).
 */
export interface EvidenceRecord {
  schemaVersion: number;
  evidenceId: string;
  causal: EvidenceCausalIds;
  kind: EvidenceKind;
  artifact: EvidenceArtifactRef;
  provenance: EvidenceProvenance;
  /** RFC3339 timestamp. */
  recordedAt: string;
}
