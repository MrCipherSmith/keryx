// Release 0 append-only session types (flow 009, W7 / S2, R0-02 / RS-01).
//
// Pure structural contracts mirroring the frozen schemas — no runtime code:
//   - session-manifest.schema.json          -> SessionManifest
//   - session-entry.schema.json             -> SessionEntry / SessionEntryPayload
//   - harness-envelope.schema.json#/$defs   -> SessionEntryCausal (causalIds),
//                                              ArtifactRef (artifactRef),
//                                              Provenance (provenance)
// Consumed by session.ts (AppendOnlySession, resumeSession, migrateSession).

/** Mirrors harness-envelope.schema.json#/$defs/artifactRef. */
export interface ArtifactRef {
  artifactId: string;
  kind: string;
  path?: string;
  hash: string;
}

/** Mirrors harness-envelope.schema.json#/$defs/provenance. */
export interface Provenance {
  provenanceId: string;
  trustLevel: "trusted" | "untrusted" | "derived" | "unknown";
  sourceKind: string;
  sourceHash?: string;
  taintIds?: string[];
}

/**
 * Discriminated session-entry payload, one strict branch per
 * `session-entry.schema.json#/properties/entry` `oneOf` (each branch is
 * `additionalProperties:false`, so callers pass exactly one branch shape).
 */
export type SessionEntryPayload =
  | { type: "user_message" | "assistant_message"; text: string; provenance?: Provenance }
  | {
      type: "model_request" | "model_response" | "model_error";
      modelAttemptId: string;
      artifactRef: ArtifactRef;
    }
  | {
      type: "tool_call" | "tool_result" | "policy_decision" | "approval_request" | "approval_result";
      toolCallId: string;
      artifactRef?: ArtifactRef;
    }
  | {
      type:
        | "checkpoint"
        | "compaction"
        | "branch_metadata"
        | "evidence_link"
        | "run_pause"
        | "run_resume"
        | "run_end";
      artifactRef: ArtifactRef;
    };

/**
 * Mirrors harness-envelope.schema.json#/$defs/causalIds. The parent link is
 * `parentEventId` (never `parentEntryId`); `runId`/`sessionId`/`correlationId`
 * are required.
 */
export interface SessionEntryCausal {
  runId: string;
  sessionId: string;
  correlationId: string;
  parentEventId?: string;
  attemptId?: string;
  branchId?: string;
}

/** Mirrors session-entry.schema.json (an append-only, immutable record). */
export interface SessionEntry {
  schemaVersion: number;
  entryId: string;
  sequence: number;
  timestamp: string;
  causal: SessionEntryCausal;
  entry: SessionEntryPayload;
}

/** Mirrors session-manifest.schema.json (the authoritative local session head). */
export interface SessionManifest {
  schemaVersion: number;
  sessionId: string;
  runId: string;
  parentSessionId?: string | null;
  createdAt: string;
  appendCursor: number;
  currentLeafEntryId: string;
  policyFingerprint: string;
  contextManifestHash: string;
  branchIds?: string[];
  evidenceLedgerId?: string;
}

/** Immutable seed for a fresh {@link SessionManifest} / AppendOnlySession. */
export interface SessionSeed {
  sessionId: string;
  runId: string;
  createdAt: string;
  policyFingerprint: string;
  contextManifestHash: string;
  parentSessionId?: string | null;
}
