// Hand-written runtime validator for `learned-pattern.schema.json` (no ajv in
// this repo — same convention as `src/harness/hooks/config.ts`'s schema
// validation). Every rule below is a direct translation of one schema
// constraint; keep this file and `learned-pattern.schema.json` in sync (the
// byte-identical-copy test in `schema.test.ts` only proves the JSON file
// matches the docs copy, not that this validator matches the JSON — that is
// this file's own job, exercised by its fixtures).
import { confidenceLevelFor, MAX_EVIDENCE_WEIGHT } from "./confidence";
import type {
  ConfidenceLevel,
  EvidenceItem,
  EvidenceKind,
  EvidenceSourceType,
  Graduation,
  GraduationTarget,
  LearnedPattern,
  LearningDomain,
  LearningScope,
  LearningStatus,
  ObservationEvent,
  ObservationEventName,
  Provenance,
  Redaction,
  ReviewerProfile,
} from "./types";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function ok(): ValidationResult {
  return { ok: true, errors: [] };
}

function fail(errors: string[]): ValidationResult {
  return { ok: false, errors };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((key) => !allowed.includes(key));
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROJECT_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
// O-4: `sessionId`/`toolUseId` are host-supplied — bounded and shape-checked
// rather than accepted as any non-empty string. `observe.ts`'s
// `buildObservationLine` already normalizes any out-of-pattern value to a
// digest-derived stand-in before it reaches this validator; this check is
// the second, independent enforcement point (defense in depth: a line built
// by anything other than `buildObservationLine` is still refused).
const SESSION_OR_TOOL_USE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

const DOMAINS: readonly LearningDomain[] = [
  "code-style",
  "architecture",
  "testing",
  "security",
  "review-conventions",
  "workflow",
  "documentation",
  "performance",
  "tooling",
  "other",
];
const SCOPES: readonly LearningScope[] = ["project", "user"];
const STATUSES: readonly LearningStatus[] = ["candidate", "accepted", "rejected", "superseded", "expired"];
const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ["low", "medium", "high"];
const EVIDENCE_KINDS: readonly EvidenceKind[] = ["reinforcement", "contradiction"];
const EVIDENCE_SOURCE_TYPES: readonly EvidenceSourceType[] = [
  "review",
  "test",
  "failure",
  "health",
  "memory",
  "observation",
  "reviewer-comment",
];
const GRADUATION_TARGETS: readonly GraduationTarget[] = ["skill", "agent", "rule"];
const EXTRACTOR_KINDS: readonly ("deterministic" | "model-backed")[] = ["deterministic", "model-backed"];
const IDENTITY_KINDS: readonly ("remote-hash" | "path-hash")[] = ["remote-hash", "path-hash"];
const OBSERVATION_EVENT_NAMES: readonly ObservationEventName[] = [
  "tool-start",
  "tool-complete",
  "tool-failed",
  "user-prompt",
  "session-start",
  "turn-stop",
  "session-end",
];

/** True when `confidenceLevel` (when present) equals the bucket derived from `confidence`. */
export function confidenceLevelConsistent(confidence: number, confidenceLevel: unknown): boolean {
  if (confidenceLevel === undefined) return true;
  return confidenceLevel === confidenceLevelFor(confidence);
}

function validateProject(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const extra = unknownKeys(value, ["identity", "identityKind", "displayName"]);
  for (const key of extra) errors.push(`${path}.${key}: unknown property`);
  if (typeof value.identity !== "string" || !PROJECT_IDENTITY_PATTERN.test(value.identity)) {
    errors.push(`${path}.identity: must match ^[a-f0-9]{64}$`);
  }
  if (typeof value.identityKind !== "string" || !IDENTITY_KINDS.includes(value.identityKind as never)) {
    errors.push(`${path}.identityKind: must be one of ${IDENTITY_KINDS.join(", ")}`);
  }
  if (value.displayName !== undefined && typeof value.displayName !== "string") {
    errors.push(`${path}.displayName: must be a string`);
  }
}

function validateEvidenceItem(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const extra = unknownKeys(value, ["kind", "sourceType", "sourceRef", "observedAt", "weight"]);
  for (const key of extra) errors.push(`${path}.${key}: unknown property`);
  if (typeof value.kind !== "string" || !EVIDENCE_KINDS.includes(value.kind as never)) {
    errors.push(`${path}.kind: must be one of ${EVIDENCE_KINDS.join(", ")}`);
  }
  if (typeof value.sourceType !== "string" || !EVIDENCE_SOURCE_TYPES.includes(value.sourceType as never)) {
    errors.push(`${path}.sourceType: must be one of ${EVIDENCE_SOURCE_TYPES.join(", ")}`);
  }
  if (typeof value.sourceRef !== "string" || value.sourceRef.length < 1) {
    errors.push(`${path}.sourceRef: must be a non-empty string`);
  }
  if (!isIsoDateTime(value.observedAt)) {
    errors.push(`${path}.observedAt: must be an ISO 8601 date-time string`);
  }
  if (value.weight !== undefined) {
    if (typeof value.weight !== "number" || value.weight < 0 || value.weight > MAX_EVIDENCE_WEIGHT) {
      errors.push(`${path}.weight: must be a number in [0, ${MAX_EVIDENCE_WEIGHT}]`);
    }
  }
}

function validateReviewerProfile(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const extra = unknownKeys(value, ["reviewerId", "generalizedFrom"]);
  for (const key of extra) errors.push(`${path}.${key}: unknown property`);
  if (typeof value.reviewerId !== "string" || value.reviewerId.length < 1) {
    errors.push(`${path}.reviewerId: must be a non-empty string`);
  }
  if (typeof value.generalizedFrom !== "number" || !Number.isInteger(value.generalizedFrom) || value.generalizedFrom < 1) {
    errors.push(`${path}.generalizedFrom: must be an integer >= 1`);
  }
}

function validateRedaction(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const extra = unknownKeys(value, ["scanned", "findings"]);
  for (const key of extra) errors.push(`${path}.${key}: unknown property`);
  if (value.scanned !== true) {
    errors.push(`${path}.scanned: must be literal true`);
  }
  if (!Array.isArray(value.findings) || value.findings.some((f) => typeof f !== "string")) {
    errors.push(`${path}.findings: must be an array of strings`);
  }
}

function validateGraduation(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const extra = unknownKeys(value, ["target", "proposalPath"]);
  for (const key of extra) errors.push(`${path}.${key}: unknown property`);
  if (typeof value.target !== "string" || !GRADUATION_TARGETS.includes(value.target as never)) {
    errors.push(`${path}.target: must be one of ${GRADUATION_TARGETS.join(", ")}`);
  }
  if (typeof value.proposalPath !== "string" || value.proposalPath.length < 1) {
    errors.push(`${path}.proposalPath: must be a non-empty string`);
  }
}

function validateProvenance(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const extra = unknownKeys(value, ["extractor", "extractorKind"]);
  for (const key of extra) errors.push(`${path}.${key}: unknown property`);
  if (typeof value.extractor !== "string" || value.extractor.length < 1) {
    errors.push(`${path}.extractor: must be a non-empty string`);
  }
  if (value.extractorKind !== undefined && !EXTRACTOR_KINDS.includes(value.extractorKind as never)) {
    errors.push(`${path}.extractorKind: must be one of ${EXTRACTOR_KINDS.join(", ")}`);
  }
}

function validateTtl(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const extra = unknownKeys(value, ["expiresAt"]);
  for (const key of extra) errors.push(`${path}.${key}: unknown property`);
  if (!isIsoDateTime(value.expiresAt)) {
    errors.push(`${path}.expiresAt: must be an ISO 8601 date-time string`);
  }
}

const LEARNED_PATTERN_KEYS = [
  "schemaVersion",
  "id",
  "trigger",
  "action",
  "domain",
  "scope",
  "project",
  "confidence",
  "confidenceLevel",
  "status",
  "supersededBy",
  "evidence",
  "reviewerProfile",
  "redaction",
  "graduation",
  "provenance",
  "ttl",
  "createdAt",
  "updatedAt",
] as const;

const LEARNED_PATTERN_REQUIRED = [
  "schemaVersion",
  "id",
  "trigger",
  "action",
  "domain",
  "scope",
  "project",
  "confidence",
  "status",
  "evidence",
  "provenance",
  "redaction",
  "createdAt",
  "updatedAt",
] as const;

/** Validates `value` against every rule in `learned-pattern.schema.json`, including its three `allOf` conditionals. */
export function validateLearnedPattern(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return fail(["value: must be an object"]);
  }

  for (const key of LEARNED_PATTERN_REQUIRED) {
    if (!(key in value)) errors.push(`${key}: required property missing`);
  }
  for (const key of unknownKeys(value, LEARNED_PATTERN_KEYS)) {
    errors.push(`${key}: unknown property`);
  }

  if (value.schemaVersion !== 1) {
    errors.push("schemaVersion: must be the literal integer 1");
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    errors.push("id: must match ^[a-z0-9][a-z0-9._-]{0,127}$");
  }
  if (typeof value.trigger !== "string" || value.trigger.length < 8 || value.trigger.length > 400) {
    errors.push("trigger: must be a string of length 8-400");
  }
  if (typeof value.action !== "string" || value.action.length < 8 || value.action.length > 400) {
    errors.push("action: must be a string of length 8-400");
  }
  if (typeof value.domain !== "string" || !DOMAINS.includes(value.domain as never)) {
    errors.push(`domain: must be one of ${DOMAINS.join(", ")}`);
  }
  if (typeof value.scope !== "string" || !SCOPES.includes(value.scope as never)) {
    errors.push(`scope: must be one of ${SCOPES.join(", ")}`);
  }
  if ("project" in value) validateProject(value.project, "project", errors);

  let confidence: number | undefined;
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    errors.push("confidence: must be a number in [0, 1]");
  } else {
    confidence = value.confidence;
  }

  if (value.confidenceLevel !== undefined) {
    if (typeof value.confidenceLevel !== "string" || !CONFIDENCE_LEVELS.includes(value.confidenceLevel as never)) {
      errors.push(`confidenceLevel: must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
    } else if (confidence !== undefined && !confidenceLevelConsistent(confidence, value.confidenceLevel)) {
      errors.push(
        `confidenceLevel: "${value.confidenceLevel}" is inconsistent with confidence ${confidence} (expected "${confidenceLevelFor(confidence)}")`,
      );
    }
  }

  if (typeof value.status !== "string" || !STATUSES.includes(value.status as never)) {
    errors.push(`status: must be one of ${STATUSES.join(", ")}`);
  }

  if (value.supersededBy !== undefined && value.supersededBy !== null && typeof value.supersededBy !== "string") {
    errors.push("supersededBy: must be a string or null");
  }

  if (!Array.isArray(value.evidence) || value.evidence.length < 1) {
    errors.push("evidence: must be a non-empty array");
  } else {
    value.evidence.forEach((item, index) => validateEvidenceItem(item, `evidence[${index}]`, errors));
  }

  if (value.reviewerProfile !== undefined && value.reviewerProfile !== null) {
    validateReviewerProfile(value.reviewerProfile, "reviewerProfile", errors);
  }

  if ("redaction" in value) validateRedaction(value.redaction, "redaction", errors);

  if (value.graduation !== undefined && value.graduation !== null) {
    validateGraduation(value.graduation, "graduation", errors);
  }

  if ("provenance" in value) validateProvenance(value.provenance, "provenance", errors);

  if (value.ttl !== undefined) validateTtl(value.ttl, "ttl", errors);

  if (!isIsoDateTime(value.createdAt)) errors.push("createdAt: must be an ISO 8601 date-time string");
  if (!isIsoDateTime(value.updatedAt)) errors.push("updatedAt: must be an ISO 8601 date-time string");

  // allOf #1: status === "superseded" <=> supersededBy is a non-empty string; else it must be null.
  if (value.status === "superseded") {
    if (typeof value.supersededBy !== "string" || value.supersededBy.length < 1) {
      errors.push('supersededBy: required (non-empty string) when status is "superseded"');
    }
  } else if (value.supersededBy !== null) {
    errors.push('supersededBy: must be null when status is not "superseded"');
  }

  // allOf #2: domain !== "review-conventions" => reviewerProfile must be null.
  if (value.domain !== "review-conventions" && value.reviewerProfile !== null && value.reviewerProfile !== undefined) {
    errors.push('reviewerProfile: must be null when domain is not "review-conventions"');
  }

  // allOf #3: status === "candidate" <=> ttl is required; else ttl must be absent.
  if (value.status === "candidate") {
    if (!("ttl" in value) || value.ttl === undefined) {
      errors.push('ttl: required when status is "candidate"');
    }
  } else if ("ttl" in value && value.ttl !== undefined) {
    errors.push('ttl: must be absent when status is not "candidate"');
  }

  return errors.length === 0 ? ok() : fail(errors);
}

const OBSERVATION_EVENT_KEYS = [
  "schemaVersion",
  "event",
  "tool",
  "inputDigest",
  "inputPreview",
  "outputPreview",
  "sessionId",
  "toolUseId",
  "cwdHash",
  "project",
  "observedAt",
  "edit",
] as const;

const OBSERVATION_EVENT_REQUIRED = [
  "schemaVersion",
  "event",
  "tool",
  "inputDigest",
  "inputPreview",
  "outputPreview",
  "sessionId",
  "toolUseId",
  "cwdHash",
  "project",
  "observedAt",
] as const;

const MAX_PREVIEW_LEN = 200;

function validateObservationProject(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push("project: must be an object");
    return;
  }
  const extra = unknownKeys(value, ["identity", "identityKind"]);
  for (const key of extra) errors.push(`project.${key}: unknown property`);
  if (typeof value.identity !== "string" || !PROJECT_IDENTITY_PATTERN.test(value.identity)) {
    errors.push("project.identity: must match ^[a-f0-9]{64}$");
  }
  if (typeof value.identityKind !== "string" || !IDENTITY_KINDS.includes(value.identityKind as never)) {
    errors.push(`project.identityKind: must be one of ${IDENTITY_KINDS.join(", ")}`);
  }
}

function validateEdit(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push("edit: must be an object");
    return;
  }
  const extra = unknownKeys(value, ["pathDigest", "removedDigest", "addedDigest"]);
  for (const key of extra) errors.push(`edit.${key}: unknown property`);
  if (typeof value.pathDigest !== "string" || !SHA256_HEX_PATTERN.test(value.pathDigest)) {
    errors.push("edit.pathDigest: must be a sha256 hex digest");
  }
  for (const field of ["removedDigest", "addedDigest"] as const) {
    const v = value[field];
    if (v !== null && (typeof v !== "string" || !SHA256_HEX_PATTERN.test(v))) {
      errors.push(`edit.${field}: must be a sha256 hex digest or null`);
    }
  }
}

/** Validates one JSONL observation-event line against the W3 spec's "Observation event contract" table, plus the optional D3 `edit` field. */
export function validateObservationEvent(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return fail(["value: must be an object"]);
  }

  for (const key of OBSERVATION_EVENT_REQUIRED) {
    if (!(key in value)) errors.push(`${key}: required property missing`);
  }
  for (const key of unknownKeys(value, OBSERVATION_EVENT_KEYS)) {
    errors.push(`${key}: unknown property`);
  }

  if (value.schemaVersion !== 1) errors.push("schemaVersion: must be the literal integer 1");

  if (typeof value.event !== "string" || !OBSERVATION_EVENT_NAMES.includes(value.event as never)) {
    errors.push(`event: must be one of ${OBSERVATION_EVENT_NAMES.join(", ")}`);
  }

  if (value.tool !== null && (typeof value.tool !== "string" || !TOOL_NAME_PATTERN.test(value.tool))) {
    errors.push(`tool: must be null or match ${TOOL_NAME_PATTERN}`);
  }

  if (typeof value.inputDigest !== "string" || !SHA256_HEX_PATTERN.test(value.inputDigest)) {
    errors.push("inputDigest: must be a sha256 hex digest");
  }

  if (typeof value.inputPreview !== "string" || value.inputPreview.length > MAX_PREVIEW_LEN) {
    errors.push(`inputPreview: must be a string of at most ${MAX_PREVIEW_LEN} chars`);
  }

  if (value.outputPreview !== null && (typeof value.outputPreview !== "string" || value.outputPreview.length > MAX_PREVIEW_LEN)) {
    errors.push(`outputPreview: must be null or a string of at most ${MAX_PREVIEW_LEN} chars`);
  }

  if (typeof value.sessionId !== "string" || !SESSION_OR_TOOL_USE_ID_PATTERN.test(value.sessionId)) {
    errors.push(`sessionId: must match ${SESSION_OR_TOOL_USE_ID_PATTERN}`);
  }

  if (value.toolUseId !== null && (typeof value.toolUseId !== "string" || !SESSION_OR_TOOL_USE_ID_PATTERN.test(value.toolUseId))) {
    errors.push(`toolUseId: must be null or match ${SESSION_OR_TOOL_USE_ID_PATTERN}`);
  }

  if (typeof value.cwdHash !== "string" || !SHA256_HEX_PATTERN.test(value.cwdHash)) {
    errors.push("cwdHash: must be a sha256 hex digest");
  }

  if ("project" in value) validateObservationProject(value.project, errors);

  if (!isIsoDateTime(value.observedAt)) errors.push("observedAt: must be an ISO 8601 date-time string");

  if (value.edit !== undefined && value.edit !== null) {
    validateEdit(value.edit, errors);
  }

  return errors.length === 0 ? ok() : fail(errors);
}

// Re-exported so callers that only need type-shaped helpers don't have to
// import `./types` separately for these.
export type {
  EvidenceItem,
  Graduation,
  LearnedPattern,
  ObservationEvent,
  Provenance,
  Redaction,
  ReviewerProfile,
};
