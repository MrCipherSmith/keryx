import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Phase 0 Shared Agent Context contracts.  This module deliberately has no
 * persistence, Flow, MCP, or Security-module dependency: callers supply the
 * current ACL and strict-guard decisions at their boundary.
 */

export type SacSchema =
  | "workspace-manifest"
  | "fwk-receipt"
  | "access-receipt"
  | "workspace-proposal"
  | "review-decision";

export type SacValidationError = { code: string; path: string; message: string };
export type SacValidationResult = { valid: boolean; errors: SacValidationError[] };
type RecordValue = Record<string, unknown>;
type JsonSchema = Record<string, unknown>;

const idPattern = /^[a-z][a-z0-9-]{2,63}$/;
const subjectPattern = /^(?:user|team|service|agent):[a-z0-9][a-z0-9._-]{0,127}$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/;
const workspacePathPattern = /^\.\/(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const utcPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
const forbiddenPayloadKeys = new Set(["prompt", "transcript", "hiddenReasoning", "secret", "secrets", "rawContent"]);
const normativeSchemaFiles: Record<SacSchema, string> = {
  "workspace-manifest": "workspace-manifest.schema.json",
  "fwk-receipt": "fwk-receipt.schema.json",
  "access-receipt": "access-receipt.schema.json",
  "workspace-proposal": "workspace-proposal.schema.json",
  "review-decision": "review-decision.schema.json",
};
const normativeSchemas = new Map<SacSchema, Promise<JsonSchema>>();

type StrictUtcInstant = Readonly<{ epochSeconds: number; fractionalDigits: string }>;

/**
 * Parses the SAC RFC3339 UTC profile without JavaScript's date normalization.
 * The Date instance is used only after extracting numeric components, and its
 * UTC fields must round-trip exactly. This rejects values such as February 30
 * that `Date.parse` would silently normalize into a different instant.
 */
function parseStrictRfc3339Utc(value: unknown): StrictUtcInstant | undefined {
  if (typeof value !== "string") return undefined;
  const match = utcPattern.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionalDigits = ""] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
  ) return undefined;
  return { epochSeconds: date.getTime() / 1000, fractionalDigits };
}

function compareStrictUtc(left: StrictUtcInstant, right: StrictUtcInstant): number {
  if (left.epochSeconds !== right.epochSeconds) return left.epochSeconds < right.epochSeconds ? -1 : 1;
  const width = Math.max(left.fractionalDigits.length, right.fractionalDigits.length);
  const leftFraction = left.fractionalDigits.padEnd(width, "0");
  const rightFraction = right.fractionalDigits.padEnd(width, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadNormativeSchema(schema: SacSchema): Promise<JsonSchema> {
  let pending = normativeSchemas.get(schema);
  if (!pending) {
    pending = readFile(new URL(`../../docs/requirements/shared-agent-context/schemas/${normativeSchemaFiles[schema]}`, import.meta.url), "utf8")
      .then((source) => JSON.parse(source) as JsonSchema);
    normativeSchemas.set(schema, pending);
  }
  return pending;
}

function resolveSchemaRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isRecord(current) ? current : undefined;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
  }
  return false;
}

/**
 * Small, pinned Draft 2020-12 contract evaluator for the vocabulary used by
 * the SAC normative schema files.  It deliberately evaluates the schemas at
 * runtime instead of mirroring selected fields in TypeScript.  `x-*` keywords
 * remain application semantics and are checked by the validators below.
 */
function validateNormativeSchema(root: JsonSchema, schema: JsonSchema, value: unknown, errors: SacValidationError[], field: string): boolean {
  const start = errors.length;
  if (typeof schema.$ref === "string") {
    const target = resolveSchemaRef(root, schema.$ref);
    if (!target) error(errors, "schema_ref", field, `unresolvable normative schema reference ${schema.$ref}`);
    else validateNormativeSchema(root, target, value, errors, field);
    return errors.length === start;
  }
  if (Array.isArray(schema.oneOf)) {
    const candidates = schema.oneOf.map((candidate) => {
      const candidateErrors: SacValidationError[] = [];
      const valid = isRecord(candidate) && validateNormativeSchema(root, candidate, value, candidateErrors, field);
      return { valid, errors: candidateErrors };
    });
    const matched = candidates.filter((candidate) => candidate.valid).length;
    if (matched !== 1) error(errors, "schema_one_of", field, "must match exactly one normative schema branch");
    if (matched === 0) errors.push(...(candidates.sort((left, right) => left.errors.length - right.errors.length)[0]?.errors ?? []));
    return errors.length === start;
  }
  if (Array.isArray(schema.allOf)) for (const candidate of schema.allOf) if (isRecord(candidate)) validateNormativeSchema(root, candidate, value, errors, field);
  if (isRecord(schema.if)) {
    const conditionErrors: SacValidationError[] = [];
    const branch = validateNormativeSchema(root, schema.if, value, conditionErrors, field) ? schema.then : schema.else;
    if (isRecord(branch)) validateNormativeSchema(root, branch, value, errors, field);
  }
  if (isRecord(schema.not)) {
    const prohibitedErrors: SacValidationError[] = [];
    if (validateNormativeSchema(root, schema.not, value, prohibitedErrors, field)) error(errors, "schema_not", field, "matches a prohibited normative schema branch");
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((candidate) => isRecord(candidate) && validateNormativeSchema(root, candidate, value, [], field));
    if (!matched) error(errors, "schema_any_of", field, "must match a normative schema branch");
  }
  if (schema.const !== undefined && value !== schema.const) error(errors, "schema_const", field, "does not match normative const");
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => value === candidate)) error(errors, "schema_enum", field, "does not match normative enum");
  if (schema.type === "object" && !isRecord(value)) { error(errors, "schema_type", field, "must be an object"); return false; }
  if (isRecord(value) && (schema.type === "object" || isRecord(schema.properties) || Array.isArray(schema.required) || schema.additionalProperties === false)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === "string" && !(key in value)) error(errors, "required", `${field}.${key}`, "is required by normative schema");
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) error(errors, "additional_property", `${field}.${key}`, "is not allowed by normative schema");
    for (const [key, propertySchema] of Object.entries(properties)) if (key in value && isRecord(propertySchema)) validateNormativeSchema(root, propertySchema, value[key], errors, `${field}.${key}`);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) { error(errors, "schema_type", field, "must be an array"); return false; }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) error(errors, "schema_min_items", field, "has fewer than the normative minimum items");
    if (schema.uniqueItems === true) for (let left = 0; left < value.length; left += 1) for (let right = left + 1; right < value.length; right += 1) if (jsonEqual(value[left], value[right])) error(errors, "schema_unique_items", `${field}[${right}]`, "duplicates an earlier item prohibited by the normative schema");
    if (isRecord(schema.items)) value.forEach((item, index) => validateNormativeSchema(root, schema.items as JsonSchema, item, errors, `${field}[${index}]`));
    if (isRecord(schema.contains)) {
      const matches = value.filter((item) => validateNormativeSchema(root, schema.contains as JsonSchema, item, [], field)).length;
      const minimum = typeof schema.minContains === "number" ? schema.minContains : 1;
      if (matches < minimum) error(errors, "schema_min_contains", field, "has fewer than the normative required contains matches");
      if (typeof schema.maxContains === "number" && matches > schema.maxContains) error(errors, "schema_max_contains", field, "has more than the normative allowed contains matches");
    }
  }
  if (schema.type === "string") {
    if (typeof value !== "string") { error(errors, "schema_type", field, "must be a string"); return false; }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) error(errors, "schema_min_length", field, "is shorter than the normative minimum");
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) error(errors, "schema_max_length", field, "is longer than the normative maximum");
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern).test(value))) error(errors, "schema_pattern", field, "does not match normative pattern");
    if (schema.format === "date-time" && !parseStrictRfc3339Utc(value)) error(errors, "schema_format", field, "is not a valid date-time");
  }
  if (schema.type === "integer" && (!Number.isInteger(value))) error(errors, "schema_type", field, "must be an integer");
  if ((schema.type === "integer" || schema.type === "number") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) error(errors, "schema_minimum", field, "is lower than normative minimum");
    if (typeof schema.maximum === "number" && value > schema.maximum) error(errors, "schema_maximum", field, "is higher than normative maximum");
  }
  return errors.length === start;
}

function error(errors: SacValidationError[], code: string, field: string, message: string): void {
  errors.push({ code, path: field, message });
}

function requireObject(value: unknown, errors: SacValidationError[], field: string): value is RecordValue {
  if (!isRecord(value)) {
    error(errors, "schema_type", field, "must be an object");
    return false;
  }
  return true;
}

function closedObject(value: RecordValue, allowed: readonly string[], errors: SacValidationError[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) error(errors, "additional_property", `${field}.${key}`, "is not allowed by this contract");
    if (forbiddenPayloadKeys.has(key)) error(errors, "forbidden_payload", `${field}.${key}`, "raw sensitive payloads are forbidden");
  }
}

function required(value: RecordValue, keys: readonly string[], errors: SacValidationError[], field: string): void {
  for (const key of keys) if (!(key in value)) error(errors, "required", `${field}.${key}`, "is required");
}

function stringMatch(value: unknown, pattern: RegExp, errors: SacValidationError[], field: string, code = "schema_pattern"): boolean {
  if (typeof value !== "string" || !pattern.test(value)) {
    error(errors, code, field, "has an invalid value");
    return false;
  }
  return true;
}

function utc(value: unknown, errors: SacValidationError[], field: string): value is string {
  if (!parseStrictRfc3339Utc(value)) {
    error(errors, "invalid_utc_timestamp", field, "has an invalid UTC timestamp");
    return false;
  }
  return true;
}

function workspaceUri(value: unknown, errors: SacValidationError[], field: string): boolean {
  if (!stringMatch(value, workspacePathPattern, errors, field, "unsafe_workspace_reference")) return false;
  return true;
}

function ordered(earlier: unknown, later: unknown, errors: SacValidationError[], field: string): void {
  const earlierInstant = parseStrictRfc3339Utc(earlier);
  const laterInstant = parseStrictRfc3339Utc(later);
  if (earlierInstant && laterInstant && compareStrictUtc(earlierInstant, laterInstant) > 0) {
    error(errors, "invalid_temporal_order", field, "timestamps must be non-decreasing");
  }
}

function validateEvidence(value: unknown, errors: SacValidationError[], field: string, trusted = true): void {
  if (!requireObject(value, errors, field)) return;
  const allowed = trusted ? ["kind", "uri", "revision", "observedAt", "trust"] : ["kind", "uri", "revision", "observedAt"];
  closedObject(value, allowed, errors, field);
  required(value, allowed, errors, field);
  if (typeof value.kind !== "string" || value.kind.length === 0) error(errors, "schema_type", `${field}.kind`, "must be a non-empty string");
  workspaceUri(value.uri, errors, `${field}.uri`);
  stringMatch(value.revision, revisionPattern, errors, `${field}.revision`);
  utc(value.observedAt, errors, `${field}.observedAt`);
  if (trusted && !["primary", "accepted", "reviewed"].includes(value.trust as string)) error(errors, "schema_enum", `${field}.trust`, "has an invalid trust level");
}

function validateWorkspace(document: RecordValue, errors: SacValidationError[]): void {
  const allowed = ["schemaVersion", "id", "title", "status", "members", "resources", "createdAt", "updatedAt"];
  closedObject(document, allowed, errors, "$"); required(document, allowed, errors, "$");
  if (document.schemaVersion !== "1.0") error(errors, "schema_const", "$.schemaVersion", "must be 1.0");
  stringMatch(document.id, idPattern, errors, "$.id");
  if (typeof document.title !== "string" || document.title.length < 1 || document.title.length > 160) error(errors, "schema_length", "$.title", "must be 1..160 characters");
  if (!["active", "archived"].includes(document.status as string)) error(errors, "schema_enum", "$.status", "has an invalid status");
  if (!Array.isArray(document.members) || document.members.length === 0) error(errors, "schema_min_items", "$.members", "must contain a member");
  else {
    const subjects = new Set<string>(); let owners = 0;
    document.members.forEach((member, index) => {
      const field = `$.members[${index}]`;
      if (!requireObject(member, errors, field)) return;
      closedObject(member, ["subject", "role"], errors, field); required(member, ["subject", "role"], errors, field);
      stringMatch(member.subject, subjectPattern, errors, `${field}.subject`);
      if (!["owner", "editor", "viewer"].includes(member.role as string)) error(errors, "schema_enum", `${field}.role`, "has an invalid role");
      if (member.role === "owner") owners += 1;
      if (typeof member.subject === "string") {
        if (subjects.has(member.subject)) error(errors, "duplicate_subject_role", `${field}.subject`, "a canonical subject may have only one role");
        subjects.add(member.subject);
      }
    });
    if (owners !== 1) error(errors, "role_topology", "$.members", "exactly one owner is required");
  }
  if (!Array.isArray(document.resources)) error(errors, "schema_type", "$.resources", "must be an array");
  else {
    const resourceUris = new Set<string>();
    document.resources.forEach((resource, index) => {
    const field = `$.resources[${index}]`;
    if (!requireObject(resource, errors, field)) return;
    closedObject(resource, ["kind", "uri", "revision"], errors, field); required(resource, ["kind", "uri"], errors, field);
    if (!["component", "repository", "flow", "wiki", "memory", "skill", "evidence", "worktree", "session"].includes(resource.kind as string)) error(errors, "schema_enum", `${field}.kind`, "has an invalid kind");
    workspaceUri(resource.uri, errors, `${field}.uri`);
    if (typeof resource.uri === "string") {
      if (resourceUris.has(resource.uri)) error(errors, "duplicate_resource_reference", `${field}.uri`, "a canonical resource URI may appear only once");
      resourceUris.add(resource.uri);
    }
    if (resource.revision !== undefined) stringMatch(resource.revision, revisionPattern, errors, `${field}.revision`);
    });
  }
  utc(document.createdAt, errors, "$.createdAt"); utc(document.updatedAt, errors, "$.updatedAt"); ordered(document.createdAt, document.updatedAt, errors, "$.createdAt/updatedAt");
}

function validateFwk(document: RecordValue, errors: SacValidationError[]): void {
  const allowed = ["schemaVersion", "workspaceId", "generatedAt", "facts", "work", "knowHow", "freshness"];
  closedObject(document, allowed, errors, "$"); required(document, allowed, errors, "$");
  if (document.schemaVersion !== "1.0") error(errors, "schema_const", "$.schemaVersion", "must be 1.0");
  stringMatch(document.workspaceId, idPattern, errors, "$.workspaceId"); utc(document.generatedAt, errors, "$.generatedAt");
  if (!Array.isArray(document.facts)) error(errors, "schema_type", "$.facts", "must be an array");
  else document.facts.forEach((fact, index) => {
    const field = `$.facts[${index}]`; if (!requireObject(fact, errors, field)) return;
    closedObject(fact, ["statement", "evidence", "observedAt", "expiresAt", "freshness", "confidence"], errors, field); required(fact, ["statement", "evidence", "observedAt", "expiresAt", "freshness"], errors, field);
    if (typeof fact.statement !== "string" || fact.statement.length === 0 || fact.statement.length > 4000) error(errors, "schema_length", `${field}.statement`, "must be 1..4000 characters");
    if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) error(errors, "schema_min_items", `${field}.evidence`, "must contain evidence"); else fact.evidence.forEach((e, i) => validateEvidence(e, errors, `${field}.evidence[${i}]`));
    utc(fact.observedAt, errors, `${field}.observedAt`); utc(fact.expiresAt, errors, `${field}.expiresAt`); ordered(fact.observedAt, fact.expiresAt, errors, `${field}.observedAt/expiresAt`); ordered(fact.observedAt, document.generatedAt, errors, `${field}.observedAt/generatedAt`);
    if (!["fresh", "stale", "expired", "denied"].includes(fact.freshness as string)) error(errors, "schema_enum", `${field}.freshness`, "has an invalid freshness");
  });
  if (!requireObject(document.work, errors, "$.work")) return;
  if (document.work.state === "bound") {
    closedObject(document.work, ["state", "flowRef", "completed", "next", "blocked", "evidence"], errors, "$.work"); required(document.work, ["state", "flowRef"], errors, "$.work");
    if (!requireObject(document.work.flowRef, errors, "$.work.flowRef")) return;
    closedObject(document.work.flowRef, ["uri", "snapshot", "revision"], errors, "$.work.flowRef"); required(document.work.flowRef, ["uri", "snapshot", "revision"], errors, "$.work.flowRef"); workspaceUri(document.work.flowRef.uri, errors, "$.work.flowRef.uri"); stringMatch(document.work.flowRef.revision, revisionPattern, errors, "$.work.flowRef.revision");
  } else if (document.work.state === "unbound") {
    closedObject(document.work, ["state"], errors, "$.work");
  } else error(errors, "schema_one_of", "$.work.state", "must be bound or unbound");
  if (!Array.isArray(document.knowHow)) error(errors, "schema_type", "$.knowHow", "must be an array");
  else document.knowHow.forEach((item, index) => { const field = `$.knowHow[${index}]`; if (!requireObject(item, errors, field)) return; closedObject(item, ["kind", "uri", "revision", "trust", "status", "applicability"], errors, field); required(item, ["kind", "uri", "revision", "trust", "status"], errors, field); workspaceUri(item.uri, errors, `${field}.uri`); stringMatch(item.revision, revisionPattern, errors, `${field}.revision`); if (!["wiki", "memory", "skill"].includes(item.kind as string) || !["accepted", "reviewed"].includes(item.trust as string) || !["fresh", "stale", "withdrawn", "denied"].includes(item.status as string)) error(errors, "schema_enum", field, "has invalid know-how values"); });
  if (!["fresh", "stale", "partial", "denied"].includes(document.freshness as string)) error(errors, "schema_enum", "$.freshness", "has invalid freshness");
}

function validateActor(value: unknown, errors: SacValidationError[], field: string): void {
  if (!requireObject(value, errors, field)) return;
  closedObject(value, ["subject", "authority", "trustedPrincipalRef"], errors, field); required(value, ["subject", "authority", "trustedPrincipalRef"], errors, field);
  stringMatch(value.subject, subjectPattern, errors, `${field}.subject`); if (!["owner", "editor"].includes(value.authority as string)) error(errors, "schema_enum", `${field}.authority`, "must be owner or editor"); workspaceUri(value.trustedPrincipalRef, errors, `${field}.trustedPrincipalRef`);
}

function validateProposal(document: RecordValue, errors: SacValidationError[]): void {
  if (document.recordType === "proposal-created") {
    const allowed = ["schemaVersion", "recordType", "id", "proposalRevision", "correlationId", "workspaceId", "kind", "status", "summary", "evidence", "wrapUp", "author", "security", "createdAt"];
    closedObject(document, allowed, errors, "$"); required(document, allowed, errors, "$");
    if (document.status !== "proposed") error(errors, "schema_const", "$.status", "new proposals must be proposed");
    stringMatch(document.id, idPattern, errors, "$.id"); stringMatch(document.workspaceId, idPattern, errors, "$.workspaceId"); stringMatch(document.proposalRevision, revisionPattern, errors, "$.proposalRevision"); stringMatch(document.correlationId, correlationPattern, errors, "$.correlationId"); stringMatch(document.author, subjectPattern, errors, "$.author"); utc(document.createdAt, errors, "$.createdAt");
    if (!Array.isArray(document.evidence) || document.evidence.length === 0) error(errors, "schema_min_items", "$.evidence", "must contain evidence"); else document.evidence.forEach((item, index) => validateEvidence(item, errors, `$.evidence[${index}]`, false));
    if (!requireObject(document.wrapUp, errors, "$.wrapUp")) return;
    closedObject(document.wrapUp, ["id", "source", "sourceRef", "sourceRevision", "issuedAt", "expiresAt"], errors, "$.wrapUp"); required(document.wrapUp, ["id", "source", "sourceRef", "sourceRevision", "issuedAt", "expiresAt"], errors, "$.wrapUp");
    stringMatch(document.wrapUp.id, idPattern, errors, "$.wrapUp.id"); if (!["session", "flow"].includes(document.wrapUp.source as string)) error(errors, "schema_enum", "$.wrapUp.source", "must be explicit session or Flow wrap-up"); workspaceUri(document.wrapUp.sourceRef, errors, "$.wrapUp.sourceRef"); stringMatch(document.wrapUp.sourceRevision, revisionPattern, errors, "$.wrapUp.sourceRevision"); utc(document.wrapUp.issuedAt, errors, "$.wrapUp.issuedAt"); utc(document.wrapUp.expiresAt, errors, "$.wrapUp.expiresAt"); ordered(document.wrapUp.issuedAt, document.wrapUp.expiresAt, errors, "$.wrapUp.issuedAt/expiresAt");
    if (!requireObject(document.security, errors, "$.security")) return; closedObject(document.security, ["gate", "redacted", "policyRef", "policyRevision"], errors, "$.security"); required(document.security, ["gate", "redacted", "policyRef", "policyRevision"], errors, "$.security"); if (!["pass", "needs-approval"].includes(document.security.gate as string) || document.security.redacted !== true) error(errors, "schema_const", "$.security", "must be a redacted passing or approval gate"); workspaceUri(document.security.policyRef, errors, "$.security.policyRef"); stringMatch(document.security.policyRevision, revisionPattern, errors, "$.security.policyRevision");
  } else if (document.recordType === "proposal-write-intent") validateWriteIntent(document, errors);
  else if (document.recordType === "proposal-transition") validateTransition(document, errors);
  else error(errors, "schema_one_of", "$.recordType", "must be a proposal record type");
}

function validateWriteIntent(document: RecordValue, errors: SacValidationError[]): void {
  const allowed = ["schemaVersion", "recordType", "intentId", "proposalId", "proposalRevision", "correlationId", "workspaceId", "sequence", "priorEventHash", "idempotencyKey", "reviewer", "approvalRef", "security", "evidence", "createdAt"];
  closedObject(document, allowed, errors, "$"); required(document, allowed, errors, "$");
  ["intentId", "proposalId", "workspaceId"].forEach((key) => stringMatch(document[key], idPattern, errors, `$.${key}`)); stringMatch(document.proposalRevision, revisionPattern, errors, "$.proposalRevision"); stringMatch(document.correlationId, correlationPattern, errors, "$.correlationId"); stringMatch(document.idempotencyKey, correlationPattern, errors, "$.idempotencyKey"); utc(document.createdAt, errors, "$.createdAt");
  if (!Number.isInteger(document.sequence) || (document.sequence as number) < 1) error(errors, "schema_minimum", "$.sequence", "must be a positive integer");
  if (typeof document.priorEventHash !== "string" || !/^[a-f0-9]{64}$/.test(document.priorEventHash)) error(errors, "schema_pattern", "$.priorEventHash", "must be a hash");
  validateActor(document.reviewer, errors, "$.reviewer"); workspaceUri(document.approvalRef, errors, "$.approvalRef");
  if (!requireObject(document.security, errors, "$.security") || document.security.gate !== "pass") error(errors, "security_gate_failed", "$.security.gate", "write intent requires pass");
  if (isRecord(document.security)) { workspaceUri(document.security.policyRef, errors, "$.security.policyRef"); stringMatch(document.security.policyRevision, revisionPattern, errors, "$.security.policyRevision"); }
  if (!Array.isArray(document.evidence) || document.evidence.length === 0) error(errors, "schema_min_items", "$.evidence", "must contain evidence"); else document.evidence.forEach((item, index) => validateEvidence(item, errors, `$.evidence[${index}]`, false));
}

function validateTransition(document: RecordValue, errors: SacValidationError[]): void {
  const allowed = ["schemaVersion", "recordType", "eventId", "proposalId", "proposalRevision", "correlationId", "workspaceId", "sequence", "priorEventHash", "fromStatus", "toStatus", "occurredAt", "idempotencyKey", "acceptance", "reason"];
  closedObject(document, allowed, errors, "$"); required(document, allowed.filter((key) => key !== "acceptance" && key !== "reason"), errors, "$");
  ["eventId", "proposalId", "workspaceId"].forEach((key) => stringMatch(document[key], idPattern, errors, `$.${key}`)); stringMatch(document.proposalRevision, revisionPattern, errors, "$.proposalRevision"); stringMatch(document.correlationId, correlationPattern, errors, "$.correlationId"); stringMatch(document.idempotencyKey, correlationPattern, errors, "$.idempotencyKey"); utc(document.occurredAt, errors, "$.occurredAt");
  if (!Number.isInteger(document.sequence) || (document.sequence as number) < 1) error(errors, "schema_minimum", "$.sequence", "must be a positive integer");
  if (document.fromStatus !== "proposed" || !["accepted", "rejected", "dismissed", "stale"].includes(document.toStatus as string)) error(errors, "schema_transition", "$.toStatus", "is invalid");
  if (document.toStatus !== "accepted") { if (typeof document.reason !== "string" || document.reason.length === 0 || document.acceptance !== undefined) error(errors, "schema_conditional", "$.reason", "non-accepted transitions require only a reason"); return; }
  if (!requireObject(document.acceptance, errors, "$.acceptance")) return;
  const acceptance = document.acceptance; const acceptanceAllowed = ["reviewDecisionRef", "writeIntentRef", "reviewer", "security", "freshness", "targetWrite", "evidence", "idempotencyKey"];
  closedObject(acceptance, acceptanceAllowed, errors, "$.acceptance"); required(acceptance, acceptanceAllowed, errors, "$.acceptance"); workspaceUri(acceptance.reviewDecisionRef, errors, "$.acceptance.reviewDecisionRef"); workspaceUri(acceptance.writeIntentRef, errors, "$.acceptance.writeIntentRef"); validateActor(acceptance.reviewer, errors, "$.acceptance.reviewer"); stringMatch(acceptance.idempotencyKey, correlationPattern, errors, "$.acceptance.idempotencyKey");
  if (acceptance.idempotencyKey !== document.idempotencyKey) error(errors, "idempotency_mismatch", "$.acceptance.idempotencyKey", "must match the transition key");
  if (!requireObject(acceptance.security, errors, "$.acceptance.security") || acceptance.security.gate !== "pass") error(errors, "security_gate_failed", "$.acceptance.security.gate", "acceptance requires pass");
  if (isRecord(acceptance.security)) { workspaceUri(acceptance.security.policyRef, errors, "$.acceptance.security.policyRef"); stringMatch(acceptance.security.policyRevision, revisionPattern, errors, "$.acceptance.security.policyRevision"); }
  if (!requireObject(acceptance.freshness, errors, "$.acceptance.freshness") || acceptance.freshness.state !== "fresh") error(errors, "stale_evidence", "$.acceptance.freshness.state", "acceptance requires fresh evidence");
  if (isRecord(acceptance.freshness)) utc(acceptance.freshness.verifiedAt, errors, "$.acceptance.freshness.verifiedAt");
  if (!requireObject(acceptance.targetWrite, errors, "$.acceptance.targetWrite")) error(errors, "missing_target_write", "$.acceptance.targetWrite", "acceptance requires a guarded write receipt");
  else {
    workspaceUri(acceptance.targetWrite.receiptRef, errors, "$.acceptance.targetWrite.receiptRef"); workspaceUri(acceptance.targetWrite.targetRef, errors, "$.acceptance.targetWrite.targetRef"); utc(acceptance.targetWrite.completedAt, errors, "$.acceptance.targetWrite.completedAt");
    const binding = acceptance.targetWrite.binding;
    if (!requireObject(binding, errors, "$.acceptance.targetWrite.binding")) error(errors, "missing_receipt_binding", "$.acceptance.targetWrite.binding", "accepted transition must retain the owner receipt binding");
    else {
      const allowed = ["owner", "bindingHash", "intentRef", "proposalId", "proposalRevision", "workspaceId", "correlationId", "idempotencyKey", "reviewerSubject", "reviewerAuthority", "policyRevision"];
      closedObject(binding, allowed, errors, "$.acceptance.targetWrite.binding"); required(binding, allowed, errors, "$.acceptance.targetWrite.binding");
      if (!["wiki", "memory", "skill"].includes(binding.owner as string)) error(errors, "schema_enum", "$.acceptance.targetWrite.binding.owner", "must name a guarded knowledge owner");
      if (typeof binding.bindingHash !== "string" || !/^[a-f0-9]{64}$/.test(binding.bindingHash)) error(errors, "schema_pattern", "$.acceptance.targetWrite.binding.bindingHash", "must be a binding hash");
      workspaceUri(binding.intentRef, errors, "$.acceptance.targetWrite.binding.intentRef");
      stringMatch(binding.proposalId, idPattern, errors, "$.acceptance.targetWrite.binding.proposalId"); stringMatch(binding.proposalRevision, revisionPattern, errors, "$.acceptance.targetWrite.binding.proposalRevision"); stringMatch(binding.workspaceId, idPattern, errors, "$.acceptance.targetWrite.binding.workspaceId"); stringMatch(binding.correlationId, correlationPattern, errors, "$.acceptance.targetWrite.binding.correlationId"); stringMatch(binding.idempotencyKey, correlationPattern, errors, "$.acceptance.targetWrite.binding.idempotencyKey"); stringMatch(binding.reviewerSubject, subjectPattern, errors, "$.acceptance.targetWrite.binding.reviewerSubject"); stringMatch(binding.policyRevision, revisionPattern, errors, "$.acceptance.targetWrite.binding.policyRevision");
      if (!["owner", "editor"].includes(binding.reviewerAuthority as string)) error(errors, "schema_enum", "$.acceptance.targetWrite.binding.reviewerAuthority", "must be owner or editor");
      if (binding.intentRef !== acceptance.writeIntentRef || binding.proposalId !== document.proposalId || binding.proposalRevision !== document.proposalRevision || binding.workspaceId !== document.workspaceId || binding.correlationId !== document.correlationId || binding.idempotencyKey !== document.idempotencyKey || binding.reviewerSubject !== (isRecord(acceptance.reviewer) ? acceptance.reviewer.subject : undefined) || binding.reviewerAuthority !== (isRecord(acceptance.reviewer) ? acceptance.reviewer.authority : undefined) || binding.policyRevision !== (isRecord(acceptance.security) ? acceptance.security.policyRevision : undefined)) error(errors, "receipt_binding_mismatch", "$.acceptance.targetWrite.binding", "must bind this exact accepted transition");
      else if (binding.bindingHash !== hashSacRecord({ owner: binding.owner, intentRef: binding.intentRef, proposalId: binding.proposalId, proposalRevision: binding.proposalRevision, workspaceId: binding.workspaceId, correlationId: binding.correlationId, idempotencyKey: binding.idempotencyKey, reviewerSubject: binding.reviewerSubject, reviewerAuthority: binding.reviewerAuthority, policyRevision: binding.policyRevision })) error(errors, "receipt_binding_hash_mismatch", "$.acceptance.targetWrite.binding.bindingHash", "must hash the retained owner binding");
    }
  }
  if (!Array.isArray(acceptance.evidence) || acceptance.evidence.length === 0) error(errors, "schema_min_items", "$.acceptance.evidence", "must contain evidence"); else acceptance.evidence.forEach((item, index) => { validateEvidence(item, errors, `$.acceptance.evidence[${index}]`, false); if (isRecord(acceptance.freshness)) ordered(isRecord(item) ? item.observedAt : undefined, acceptance.freshness.verifiedAt, errors, `$.acceptance.evidence[${index}].observedAt`); });
  if (isRecord(acceptance.freshness) && isRecord(acceptance.targetWrite)) { ordered(acceptance.freshness.verifiedAt, acceptance.targetWrite.completedAt, errors, "$.acceptance.freshness/targetWrite"); ordered(acceptance.targetWrite.completedAt, document.occurredAt, errors, "$.acceptance.targetWrite/occurredAt"); }
}

function validateReview(document: RecordValue, errors: SacValidationError[]): void {
  const allowed = ["schemaVersion", "id", "proposalId", "proposalRevision", "correlationId", "workspaceId", "decision", "reviewer", "decidedAt", "idempotencyKey", "security", "freshness", "targetWrite", "reason"];
  closedObject(document, allowed, errors, "$"); required(document, allowed.slice(0, 10), errors, "$");
  ["id", "proposalId", "workspaceId"].forEach((key) => stringMatch(document[key], idPattern, errors, `$.${key}`)); stringMatch(document.proposalRevision, revisionPattern, errors, "$.proposalRevision"); stringMatch(document.correlationId, correlationPattern, errors, "$.correlationId"); stringMatch(document.idempotencyKey, correlationPattern, errors, "$.idempotencyKey"); utc(document.decidedAt, errors, "$.decidedAt"); validateActor(document.reviewer, errors, "$.reviewer");
  if (!["accepted", "rejected", "dismissed"].includes(document.decision as string)) error(errors, "schema_enum", "$.decision", "is invalid");
  if (document.decision === "accepted") { if (!isRecord(document.security) || document.security.gate !== "pass") error(errors, "security_gate_failed", "$.security", "accepted requires a passing gate"); if (!isRecord(document.freshness) || document.freshness.state !== "fresh") error(errors, "stale_evidence", "$.freshness", "accepted requires fresh evidence"); if (!isRecord(document.targetWrite)) error(errors, "missing_target_write", "$.targetWrite", "accepted requires target write"); }
  else if (typeof document.reason !== "string" || document.reason.length === 0 || document.targetWrite !== undefined || document.freshness !== undefined) error(errors, "schema_conditional", "$.reason", "non-accepted decisions require only a reason");
}

function validateAccess(document: RecordValue, errors: SacValidationError[]): void {
  const allowed = ["schemaVersion", "id", "workspaceId", "actor", "action", "decision", "recordedAt", "cost", "contextAssembly", "policy", "integrity", "resourceRef", "outcome"];
  closedObject(document, allowed, errors, "$"); required(document, allowed.slice(0, 11), errors, "$");
  ["id", "workspaceId"].forEach((key) => stringMatch(document[key], idPattern, errors, `$.${key}`)); stringMatch(document.actor, subjectPattern, errors, "$.actor"); utc(document.recordedAt, errors, "$.recordedAt");
  if (!["overview", "fwk", "resource"].includes(document.action as string) || !["allowed", "denied", "budget-exhausted", "stale"].includes(document.decision as string)) error(errors, "schema_enum", "$.action", "has invalid access values");
  if (document.action === "resource") { if (!("resourceRef" in document)) error(errors, "required", "$.resourceRef", "resource action requires a reference"); else workspaceUri(document.resourceRef, errors, "$.resourceRef"); } else if (document.resourceRef !== undefined) error(errors, "schema_conditional", "$.resourceRef", "is only allowed for resource actions");
  if (!requireObject(document.cost, errors, "$.cost")) return; required(document.cost, ["toolCalls", "elapsedMs"], errors, "$.cost");
  if (!requireObject(document.contextAssembly, errors, "$.contextAssembly")) return; required(document.contextAssembly, ["traceRef", "configurationRevision", "selected", "omittedOptional"], errors, "$.contextAssembly"); workspaceUri(document.contextAssembly.traceRef, errors, "$.contextAssembly.traceRef");
  for (const key of ["selected", "omittedOptional"] as const) if (!Array.isArray(document.contextAssembly[key])) error(errors, "schema_type", `$.contextAssembly.${key}`, "must be an array"); else document.contextAssembly[key].forEach((ref, index) => workspaceUri(ref, errors, `$.contextAssembly.${key}[${index}]`));
  if (!requireObject(document.policy, errors, "$.policy")) return; workspaceUri(document.policy.ref, errors, "$.policy.ref"); stringMatch(document.policy.revision, revisionPattern, errors, "$.policy.revision");
}

/** Validates the five normative Draft 2020-12 SAC contracts plus their x-invariants. */
export async function validateSacContract(input: { schema: SacSchema | string; document: unknown }): Promise<SacValidationResult> {
  const errors: SacValidationError[] = [];
  if (!requireObject(input.document, errors, "$")) return { valid: false, errors };
  if (!(input.schema in normativeSchemaFiles)) {
    error(errors, "unknown_schema", "$.schema", "is not a normative SAC schema");
    return { valid: false, errors };
  }
  // Structural validity is decided from the checked-in normative schema, not
  // from a parallel TypeScript approximation.  The validators below add only
  // documented x-* semantic invariants (temporal topology, ledger causality,
  // and payload safety) before a future persistence/egress seam.
  const schema = input.schema as SacSchema;
  const normativeSchema = await loadNormativeSchema(schema);
  validateNormativeSchema(normativeSchema, normativeSchema, input.document, errors, "$");
  switch (input.schema) {
    case "workspace-manifest": validateWorkspace(input.document, errors); break;
    case "fwk-receipt": validateFwk(input.document, errors); break;
    case "workspace-proposal": validateProposal(input.document, errors); break;
    case "review-decision": validateReview(input.document, errors); break;
    case "access-receipt": validateAccess(input.document, errors); break;
  }
  // Timestamp topology is an x-invariant, and is intentionally checked even
  // when a document otherwise fails its selected structural schema.
  if ("createdAt" in input.document && "updatedAt" in input.document) {
    utc(input.document.createdAt, errors, "$.createdAt");
    utc(input.document.updatedAt, errors, "$.updatedAt");
    ordered(input.document.createdAt, input.document.updatedAt, errors, "$.createdAt/updatedAt");
  }
  return { valid: errors.length === 0, errors };
}

/** Append-only proposal transition validation, including idempotency and sequencing. */
export async function validateSacLedger(input: { events: unknown[] }): Promise<SacValidationResult> {
  const errors: SacValidationError[] = []; const idempotency = new Map<string, string>(); const sequences = new Map<string, number>(); const timestamps = new Map<string, StrictUtcInstant>(); const priorHashes = new Map<string, string>();
  for (const [index, value] of input.events.entries()) {
    const result = await validateSacContract({ schema: "workspace-proposal", document: value });
    errors.push(...result.errors.map((entry) => ({ ...entry, path: `$.events[${index}]${entry.path.slice(1)}` })));
    if (!isRecord(value) || (value.recordType !== "proposal-transition" && value.recordType !== "proposal-write-intent")) continue;
    const stream = `${value.workspaceId}:${value.proposalId}`;
    // A pending write-intent and its terminal transition intentionally share
    // the owner idempotency key. Replay detection is per record class so that
    // causal pair is valid while a second intent or terminal stays forbidden.
    const key = `${stream}:${value.recordType}:${value.idempotencyKey}`; const fingerprint = JSON.stringify(value);
    if (idempotency.has(key)) error(errors, "idempotency_replay", `$.events[${index}].idempotencyKey`, idempotency.get(key) === fingerprint ? "duplicate delivery" : "conflicting replay"); else idempotency.set(key, fingerprint);
    const expected = (sequences.get(stream) ?? 0) + 1;
    if (value.sequence !== expected) error(errors, "invalid_ledger_sequence", `$.events[${index}].sequence`, "must be the next sequence in its proposal stream");
    const expectedPriorHash = priorHashes.get(stream) ?? hashSacRecord("GENESIS");
    if (value.priorEventHash !== expectedPriorHash) error(errors, "invalid_ledger_causality", `$.events[${index}].priorEventHash`, "must hash the preceding record in its proposal stream");
    if (typeof value.sequence === "number") sequences.set(stream, value.sequence);
    const time = parseStrictRfc3339Utc(value.recordType === "proposal-write-intent" ? value.createdAt : value.occurredAt); const previous = timestamps.get(stream);
    if (previous !== undefined && time && compareStrictUtc(time, previous) < 0) error(errors, "invalid_temporal_order", `$.events[${index}].occurredAt`, "must not precede an earlier transition");
    if (time) timestamps.set(stream, time);
    priorHashes.set(stream, hashSacRecord(value));
  }
  return { valid: errors.length === 0, errors };
}

function hashSacRecord(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }

export type WorkspaceReferenceKind = "component" | "repository" | "flow" | "wiki" | "memory" | "skill" | "evidence" | "worktree" | "session" | "code" | "test" | "health" | "artifact";
export class SacReferenceError extends Error { readonly code = "unsafe_workspace_reference" as const; }

/** Resolves a typed URI only when both lexical and realpath containment hold. */
export async function resolveWorkspaceReference(input: { workspaceRoot: string; kind: WorkspaceReferenceKind; uri: string }): Promise<string> {
  if (!workspacePathPattern.test(input.uri) || path.isAbsolute(input.uri) || /^[a-z][a-z0-9+.-]*:/i.test(input.uri) || input.uri.includes("\\")) throw new SacReferenceError("unsafe workspace reference");
  const lexicalRoot = path.resolve(input.workspaceRoot); const root = await realpath(lexicalRoot); const candidate = path.resolve(lexicalRoot, input.uri.slice(2));
  if (candidate !== lexicalRoot && !candidate.startsWith(`${lexicalRoot}${path.sep}`)) throw new SacReferenceError("workspace reference escapes root");
  let resolved: string;
  try { resolved = await realpath(candidate); } catch { throw new SacReferenceError("workspace reference is not resolvable"); }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new SacReferenceError("workspace reference escapes root after realpath");
  // Return the canonical lexical path under the caller's root; `resolved` is
  // used solely for the security containment decision (macOS may realpath
  // /tmp through /private, which must not leak into the public reference).
  return candidate;
}

export type SacRole = "owner" | "editor" | "viewer" | "revoked";
export type TrustedActorContext = Readonly<{ subject: string; authenticationMethod: "local-os" | "trusted-harness"; issuedRoleRevision: string; requestCorrelationId: string }>;
const trustedActors = new WeakSet<object>();
export type SacVerifiedPrincipal = Readonly<{ subject: string; authenticationMethod: "local-os" | "trusted-harness"; roleRevision: string }>;
export type SacAuthorizationServer = Readonly<{ actorContextFor: (request: unknown, requestCorrelationId: string) => Promise<TrustedActorContext | undefined> }>;

/**
 * This is the server-owned issuance boundary.  It receives an authentication
 * adapter during server composition, and its public request method accepts no
 * caller-provided principal or role.  SAC itself exports no principal-to-actor
 * factory, so a CLI/MCP payload cannot mint a WeakSet-trusted context.
 */
export function createSacAuthorizationServer(input: { authenticateRequest: (request: unknown) => Promise<SacVerifiedPrincipal | undefined> }): SacAuthorizationServer {
  return Object.freeze({ actorContextFor: async (request, requestCorrelationId) => {
    const principal = await input.authenticateRequest(request);
    if (!principal || !subjectPattern.test(principal.subject) || !revisionPattern.test(principal.roleRevision) || !correlationPattern.test(requestCorrelationId)) return undefined;
    const actor: TrustedActorContext = Object.freeze({ subject: principal.subject, authenticationMethod: principal.authenticationMethod, issuedRoleRevision: principal.roleRevision, requestCorrelationId });
    trustedActors.add(actor);
    return actor;
  } });
}

type CurrentRole = { role: SacRole; revision: string; workspaceId: string };
type AuthorizationResult = { allowed: boolean; code: "allowed" | "untrusted_actor" | "workspace_access_denied" | "role_revoked" | "insufficient_role" | "authorization_changed"; authorizeAtUse: (resolve: () => Promise<CurrentRole>) => Promise<AuthorizationResult> };
const roleRank: Record<Exclude<SacRole, "revoked">, number> = { viewer: 1, editor: 2, owner: 3 };
function authorizationResult(allowed: boolean, code: AuthorizationResult["code"], baseline: CurrentRole, required: number, workspaceId: string): AuthorizationResult {
  return { allowed, code, authorizeAtUse: async (resolve) => {
    const current = await resolve();
    if (current.workspaceId !== workspaceId) return authorizationResult(false, "workspace_access_denied", current, required, workspaceId);
    if (current.revision !== baseline.revision) return authorizationResult(false, "authorization_changed", current, required, workspaceId);
    if (current.role === "revoked") return authorizationResult(false, "role_revoked", current, required, workspaceId);
    const currentAllowed = (roleRank[current.role] ?? 0) >= required;
    return authorizationResult(currentAllowed, currentAllowed ? "allowed" : "insufficient_role", current, required, workspaceId);
  } };
}
export async function authorizeSacUse(input: { actorContext: TrustedActorContext; workspaceId: string; action: "read" | "egress" | "write" | "review"; clientClaims?: unknown; resolveCurrentRole: (subject: string, workspaceId: string) => Promise<CurrentRole> }): Promise<AuthorizationResult> {
  const required = input.action === "read" ? 1 : 2;
  if (!isRecord(input.actorContext) || !trustedActors.has(input.actorContext)) return authorizationResult(false, "untrusted_actor", { role: "revoked", revision: "invalid", workspaceId: input.workspaceId }, required, input.workspaceId);
  const current = await input.resolveCurrentRole(input.actorContext.subject, input.workspaceId);
  if (current.workspaceId !== input.workspaceId) return authorizationResult(false, "workspace_access_denied", current, required, input.workspaceId);
  if (current.role === "revoked") return authorizationResult(false, "role_revoked", current, required, input.workspaceId);
  const allowed = (roleRank[current.role] ?? 0) >= required;
  return authorizationResult(allowed, allowed ? "allowed" : "insufficient_role", current, required, input.workspaceId);
}

export type StrictSacGuard = { mode: "strict"; availability: "available" | "unavailable" | "error" | "indeterminate"; decision?: "pass" | "fail" | "error"; policyRevision?: string } | { mode: "disabled" | "advisory"; decision?: string };
export async function evaluateStrictSacGuard(input: { guard: StrictSacGuard; operation: "read" | "egress" | "write" }): Promise<{ allowed: boolean; disclose: boolean; allowWrite: boolean; code: "strict_guard_pass" | "strict_guard_denied" }> {
  const allowed = input.guard.mode === "strict" && input.guard.availability === "available" && input.guard.decision === "pass" && typeof input.guard.policyRevision === "string" && input.guard.policyRevision.length > 0;
  return { allowed, disclose: allowed && input.operation !== "write", allowWrite: allowed && input.operation === "write", code: allowed ? "strict_guard_pass" : "strict_guard_denied" };
}
