// Hand-written validator mirroring
// `docs/requirements/keryx-agent-platform-expansion/schemas/agent-definition.schema.json`.
//
// Why hand-written rather than a JSON-Schema library: the rest of this
// package (`skill-frontmatter.ts`, `bundled-eval.ts`) already validates
// frontmatter with hand-rolled field checks rather than pulling in an
// AJV-class dependency, and this module follows the same convention. The
// risk a second, independent implementation of the same rules always
// carries — drift from the schema it mirrors — is closed by
// `schema.test.ts` (AC1): it PARSES the real schema file and asserts this
// module's required-field list, enums, name pattern and
// `additionalProperties` agree with it, field by field, rather than trusting
// that the two were written to match.
//
// Never throws: every entry point here returns a result object. A malformed
// or hostile frontmatter payload degrades to a validation failure with named
// reasons, not an exception the caller has to wrap.

import { isModelTier, MODEL_TIERS } from "../gdskills/model-tier";
import type {
  AgentDefinition,
  AgentDelegation,
  AgentExecutionKind,
  AgentOrigin,
  AgentSchemaVersion,
  AgentToolScope,
  IsolationMode,
  ModelTier,
  OriginKind,
  OutputContract,
} from "./types";

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const AGENT_DESCRIPTION_MAX_LENGTH = 1024;
export const AGENT_ROLE_MAX_LENGTH = 2000;

/** `required` in the JSON Schema, verbatim order. */
export const AGENT_REQUIRED_FIELDS = [
  "name",
  "description",
  "role",
  "tools",
  "model_tier",
  "policy_profile",
  "output_contract",
] as const;

/** Every key `properties` declares at the top level. */
export const AGENT_TOP_LEVEL_FIELDS = [
  "schema_version",
  "name",
  "description",
  "role",
  "tools",
  "model_tier",
  "policy_profile",
  "skills",
  "stacks",
  "output_contract",
  "isolation",
  "origin",
  "execution_kind",
  "tool_scope",
  "delegation",
] as const;

export const AGENT_OUTPUT_CONTRACT_VALUES = ["subagent-result"] as const;
export const AGENT_ISOLATION_VALUES = ["none", "worktree"] as const;
export const AGENT_ORIGIN_KIND_VALUES = ["authored", "generated", "imported", "learned"] as const;

/** `origin.required` + every key `origin.properties` declares. */
export const AGENT_ORIGIN_REQUIRED_FIELDS = ["kind"] as const;
export const AGENT_ORIGIN_FIELDS = ["kind", "sourceRef", "generatedAt"] as const;
export const AGENT_EXECUTION_KIND_VALUES = ["worker", "orchestrator"] as const;
export const AGENT_TOOL_SCOPE_VALUES = ["static", "parent"] as const;
export const AGENT_DELEGATION_REQUIRED_FIELDS = ["allowed_entities", "max_depth", "max_children"] as const;
export const AGENT_DELEGATION_FIELDS = [...AGENT_DELEGATION_REQUIRED_FIELDS] as const;

export type AgentSchemaErrorReason =
  | "not-an-object"
  | "missing-required-field"
  | "unknown-field"
  | "invalid-type"
  | "invalid-name-pattern"
  | "invalid-string-length"
  | "invalid-enum"
  | "duplicate-item"
  | "invalid-schema-version"
  | "v2-field-without-v2-schema"
  | "delegation-not-an-object"
  | "delegation-missing-required-field"
  | "delegation-unknown-field"
  | "delegation-invalid-type"
  | "delegation-invalid-bound"
  | "invalid-delegation-contract"
  | "origin-not-an-object"
  | "origin-missing-required-field"
  | "origin-unknown-field"
  | "origin-invalid-type"
  | "origin-invalid-enum";

export interface AgentSchemaError {
  readonly reason: AgentSchemaErrorReason;
  /** Field path (`"tools"`, `"origin.kind"`, or `"$"` for the whole document). */
  readonly field: string;
  readonly message: string;
}

export interface AgentSchemaValidationResult {
  readonly ok: boolean;
  readonly errors: readonly AgentSchemaError[];
}

function pushError(
  errors: AgentSchemaError[],
  reason: AgentSchemaErrorReason,
  field: string,
  message: string,
): void {
  errors.push({ reason, field, message });
}

function hasDuplicates(items: readonly string[]): boolean {
  return new Set(items).size !== items.length;
}

/** Validate a `tools`/`skills`/`stacks`-shaped field: array of non-empty unique strings. */
function validateStringArrayField(
  data: Record<string, unknown>,
  field: string,
  errors: AgentSchemaError[],
  options: { readonly required: boolean },
): void {
  const value = data[field];
  if (value === undefined) {
    return; // presence already checked by the required-field pass
  }
  if (!Array.isArray(value)) {
    pushError(errors, "invalid-type", field, `${field} must be an array of strings`);
    return;
  }
  const items = value as unknown[];
  if (!items.every((item): item is string => typeof item === "string" && item.length > 0)) {
    pushError(errors, "invalid-type", field, `${field} items must be non-empty strings`);
    return;
  }
  if (hasDuplicates(items as string[])) {
    pushError(errors, "duplicate-item", field, `${field} must not contain duplicate entries`);
  }
  void options; // `required` is enforced by the required-field pass; kept for call-site clarity
}

function validateOrigin(value: unknown, errors: AgentSchemaError[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    pushError(errors, "origin-not-an-object", "origin", "origin must be a mapping");
    return;
  }
  const origin = value as Record<string, unknown>;
  for (const field of AGENT_ORIGIN_REQUIRED_FIELDS) {
    if (origin[field] === undefined) {
      pushError(errors, "origin-missing-required-field", `origin.${field}`, `origin.${field} is required`);
    }
  }
  for (const key of Object.keys(origin)) {
    if (!(AGENT_ORIGIN_FIELDS as readonly string[]).includes(key)) {
      pushError(errors, "origin-unknown-field", `origin.${key}`, `origin.${key} is not a recognized field`);
    }
  }
  if (origin.kind !== undefined) {
    if (typeof origin.kind !== "string") {
      pushError(errors, "origin-invalid-type", "origin.kind", "origin.kind must be a string");
    } else if (!(AGENT_ORIGIN_KIND_VALUES as readonly string[]).includes(origin.kind)) {
      pushError(
        errors,
        "origin-invalid-enum",
        "origin.kind",
        `origin.kind must be one of ${AGENT_ORIGIN_KIND_VALUES.join(", ")}`,
      );
    }
  }
  if (origin.sourceRef !== undefined && (typeof origin.sourceRef !== "string" || origin.sourceRef.length < 1)) {
    pushError(errors, "origin-invalid-type", "origin.sourceRef", "origin.sourceRef must be a non-empty string");
  }
  if (origin.generatedAt !== undefined && typeof origin.generatedAt !== "string") {
    pushError(errors, "origin-invalid-type", "origin.generatedAt", "origin.generatedAt must be a string");
  }
}

function validateDelegation(value: unknown, errors: AgentSchemaError[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    pushError(errors, "delegation-not-an-object", "delegation", "delegation must be a mapping");
    return;
  }
  const delegation = value as Record<string, unknown>;
  for (const field of AGENT_DELEGATION_REQUIRED_FIELDS) {
    if (delegation[field] === undefined) {
      pushError(errors, "delegation-missing-required-field", `delegation.${field}`, `delegation.${field} is required`);
    }
  }
  for (const key of Object.keys(delegation)) {
    if (!(AGENT_DELEGATION_FIELDS as readonly string[]).includes(key)) {
      pushError(errors, "delegation-unknown-field", `delegation.${key}`, `delegation.${key} is not recognized`);
    }
  }
  const allowed = delegation.allowed_entities;
  if (allowed !== undefined) {
    if (!Array.isArray(allowed) || !allowed.every((item) => typeof item === "string" && AGENT_NAME_PATTERN.test(item))) {
      pushError(errors, "delegation-invalid-type", "delegation.allowed_entities", "allowed_entities must contain valid agent names");
    } else if (hasDuplicates(allowed)) {
      pushError(errors, "duplicate-item", "delegation.allowed_entities", "allowed_entities must not contain duplicates");
    }
  }
  for (const [field, maximum] of [["max_depth", 1], ["max_children", 512]] as const) {
    const bound = delegation[field];
    if (bound !== undefined) {
      if (typeof bound !== "number" || !Number.isSafeInteger(bound)) {
        pushError(errors, "delegation-invalid-type", `delegation.${field}`, `${field} must be an integer`);
      } else if (bound < 0 || bound > maximum) {
        pushError(errors, "delegation-invalid-bound", `delegation.${field}`, `${field} must be between 0 and ${maximum}`);
      }
    }
  }
}

/**
 * Validate a parsed frontmatter mapping (no `body` key — that is Markdown,
 * not part of the JSON Schema) against every rule
 * `agent-definition.schema.json` declares. Never throws.
 */
export function validateAgentFrontmatter(raw: unknown): AgentSchemaValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ reason: "not-an-object", field: "$", message: "frontmatter must be a mapping" }] };
  }
  const data = raw as Record<string, unknown>;
  const errors: AgentSchemaError[] = [];

  for (const field of AGENT_REQUIRED_FIELDS) {
    if (data[field] === undefined) {
      pushError(errors, "missing-required-field", field, `${field} is required`);
    }
  }
  for (const key of Object.keys(data)) {
    if (!(AGENT_TOP_LEVEL_FIELDS as readonly string[]).includes(key)) {
      pushError(errors, "unknown-field", key, `${key} is not a recognized agent-definition field`);
    }
  }

  if (data.schema_version !== undefined && data.schema_version !== 1 && data.schema_version !== 2) {
    pushError(errors, "invalid-schema-version", "schema_version", "schema_version must be 1 or 2");
  }

  if (data.schema_version === 2) {
    for (const field of ["execution_kind", "tool_scope", "delegation"] as const) {
      if (data[field] === undefined) pushError(errors, "missing-required-field", field, `${field} is required in schema v2`);
    }
  } else {
    for (const field of ["execution_kind", "tool_scope", "delegation"] as const) {
      if (data[field] !== undefined) {
        pushError(
          errors,
          "v2-field-without-v2-schema",
          field,
          `${field} requires schema_version: 2`,
        );
      }
    }
  }

  if (data.name !== undefined) {
    if (typeof data.name !== "string") {
      pushError(errors, "invalid-type", "name", "name must be a string");
    } else if (!AGENT_NAME_PATTERN.test(data.name)) {
      pushError(errors, "invalid-name-pattern", "name", `name must match ${AGENT_NAME_PATTERN.source}`);
    }
  }

  if (data.description !== undefined) {
    if (typeof data.description !== "string") {
      pushError(errors, "invalid-type", "description", "description must be a string");
    } else if (data.description.length < 1 || data.description.length > AGENT_DESCRIPTION_MAX_LENGTH) {
      pushError(
        errors,
        "invalid-string-length",
        "description",
        `description must be 1-${AGENT_DESCRIPTION_MAX_LENGTH} chars`,
      );
    }
  }

  if (data.role !== undefined) {
    if (typeof data.role !== "string") {
      pushError(errors, "invalid-type", "role", "role must be a string");
    } else if (data.role.length < 1 || data.role.length > AGENT_ROLE_MAX_LENGTH) {
      pushError(errors, "invalid-string-length", "role", `role must be 1-${AGENT_ROLE_MAX_LENGTH} chars`);
    }
  }

  validateStringArrayField(data, "tools", errors, { required: true });
  validateStringArrayField(data, "skills", errors, { required: false });
  validateStringArrayField(data, "stacks", errors, { required: false });

  if (data.model_tier !== undefined && !isModelTier(data.model_tier)) {
    pushError(errors, "invalid-enum", "model_tier", `model_tier must be one of ${MODEL_TIERS.join(", ")}`);
  }

  if (data.policy_profile !== undefined) {
    if (typeof data.policy_profile !== "string" || data.policy_profile.length < 1) {
      pushError(errors, "invalid-type", "policy_profile", "policy_profile must be a non-empty string");
    }
  }

  if (data.output_contract !== undefined) {
    if (!(AGENT_OUTPUT_CONTRACT_VALUES as readonly unknown[]).includes(data.output_contract)) {
      pushError(
        errors,
        "invalid-enum",
        "output_contract",
        `output_contract must be one of ${AGENT_OUTPUT_CONTRACT_VALUES.join(", ")}`,
      );
    }
  }

  if (data.isolation !== undefined) {
    if (!(AGENT_ISOLATION_VALUES as readonly unknown[]).includes(data.isolation)) {
      pushError(errors, "invalid-enum", "isolation", `isolation must be one of ${AGENT_ISOLATION_VALUES.join(", ")}`);
    }
  }

  if (data.origin !== undefined) {
    validateOrigin(data.origin, errors);
  }

  if (data.execution_kind !== undefined && !(AGENT_EXECUTION_KIND_VALUES as readonly unknown[]).includes(data.execution_kind)) {
    pushError(errors, "invalid-enum", "execution_kind", `execution_kind must be one of ${AGENT_EXECUTION_KIND_VALUES.join(", ")}`);
  }
  if (data.tool_scope !== undefined && !(AGENT_TOOL_SCOPE_VALUES as readonly unknown[]).includes(data.tool_scope)) {
    pushError(errors, "invalid-enum", "tool_scope", `tool_scope must be one of ${AGENT_TOOL_SCOPE_VALUES.join(", ")}`);
  }
  if (data.delegation !== undefined) validateDelegation(data.delegation, errors);

  const executionKind = (data.execution_kind as AgentExecutionKind | undefined) ?? "worker";
  const toolScope = (data.tool_scope as AgentToolScope | undefined) ?? "static";
  const delegation = data.delegation as Record<string, unknown> | undefined;
  const allowedEntities = Array.isArray(delegation?.allowed_entities) ? delegation.allowed_entities : [];
  const maxDepth = typeof delegation?.max_depth === "number" ? delegation.max_depth : 0;
  const maxChildren = typeof delegation?.max_children === "number" ? delegation.max_children : 0;
  if (data.schema_version === 2 && executionKind === "worker" && (toolScope !== "static" || allowedEntities.length > 0 || maxDepth !== 0 || maxChildren !== 0)) {
    pushError(errors, "invalid-delegation-contract", "execution_kind", "workers must use static tools and cannot delegate");
  }
  if (data.schema_version === 2 && executionKind === "worker" && Array.isArray(data.tools) && data.tools.includes("spawn_subagent")) {
    pushError(errors, "invalid-delegation-contract", "tools", "workers cannot declare spawn_subagent");
  }
  if (executionKind === "orchestrator") {
    const delegates = allowedEntities.length > 0 || maxDepth > 0 || maxChildren > 0;
    if (delegates && (!Array.isArray(data.tools) || !data.tools.includes("spawn_subagent"))) {
      pushError(errors, "invalid-delegation-contract", "tools", "a delegating orchestrator must declare spawn_subagent");
    }
    if (delegates && (allowedEntities.length === 0 || maxDepth === 0 || maxChildren === 0)) {
      pushError(errors, "invalid-delegation-contract", "delegation", "delegation allowlist, depth, and child count must be enabled together");
    }
  }
  if (typeof data.name === "string" && allowedEntities.includes(data.name)) {
    pushError(errors, "invalid-delegation-contract", "delegation.allowed_entities", "an agent cannot delegate to itself");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate an already-built {@link AgentDefinition} (i.e. after
 * `buildAgentDefinition`, `body` included) against the same rules — used by
 * `compile.ts`, which receives definitions rather than raw frontmatter.
 * `body` is stripped before delegating: it is Markdown, not a frontmatter
 * field, and `additionalProperties: false` would otherwise flag it as
 * unknown.
 */
export function validateAgentDefinition(definition: AgentDefinition): AgentSchemaValidationResult {
  const { body: _body, ...frontmatter } = definition as unknown as Record<string, unknown>;
  if (definition.schema_version !== 2) {
    const delegation = definition.delegation;
    const normalizedLegacyDefaults =
      definition.execution_kind === "worker" &&
      definition.tool_scope === "static" &&
      delegation?.allowed_entities.length === 0 &&
      delegation.max_depth === 0 &&
      delegation.max_children === 0;
    if (normalizedLegacyDefaults) {
      delete frontmatter.execution_kind;
      delete frontmatter.tool_scope;
      delete frontmatter.delegation;
    }
  }
  return validateAgentFrontmatter(frontmatter);
}

/**
 * Project a schema-valid raw frontmatter mapping plus its Markdown body into
 * an {@link AgentDefinition}, applying the schema's defaults (`skills: []`,
 * `stacks: []`, `isolation: "none"`). Callers must validate first
 * (`validateAgentFrontmatter(data).ok`) — this never re-validates and will
 * happily build a definition from invalid input, which is why it is not
 * exported as the only entry point.
 */
export function buildAgentDefinition(data: Record<string, unknown>, body: string): AgentDefinition {
  const originRaw = data.origin as Record<string, unknown> | undefined;
  const origin: AgentOrigin | undefined =
    originRaw === undefined
      ? undefined
      : {
          kind: originRaw.kind as OriginKind,
          ...(typeof originRaw.sourceRef === "string" ? { sourceRef: originRaw.sourceRef } : {}),
          ...(typeof originRaw.generatedAt === "string" ? { generatedAt: originRaw.generatedAt } : {}),
        };
  const delegationRaw = data.delegation as Record<string, unknown> | undefined;
  const delegation: AgentDelegation = delegationRaw === undefined
    ? { allowed_entities: [], max_depth: 0, max_children: 0 }
    : {
        allowed_entities: Array.isArray(delegationRaw.allowed_entities) ? [...(delegationRaw.allowed_entities as string[])] : [],
        max_depth: Number(delegationRaw.max_depth ?? 0),
        max_children: Number(delegationRaw.max_children ?? 0),
      };

  return {
    ...((data.schema_version === 1 || data.schema_version === 2) ? { schema_version: data.schema_version as AgentSchemaVersion } : {}),
    name: String(data.name),
    description: String(data.description),
    role: String(data.role),
    tools: Array.isArray(data.tools) ? [...(data.tools as string[])] : [],
    model_tier: data.model_tier as ModelTier,
    policy_profile: String(data.policy_profile),
    skills: Array.isArray(data.skills) ? [...(data.skills as string[])] : [],
    stacks: Array.isArray(data.stacks) ? [...(data.stacks as string[])] : [],
    output_contract: data.output_contract as OutputContract,
    isolation: (data.isolation as IsolationMode | undefined) ?? "none",
    execution_kind: (data.execution_kind as AgentExecutionKind | undefined) ?? "worker",
    tool_scope: (data.tool_scope as AgentToolScope | undefined) ?? "static",
    delegation,
    ...(origin !== undefined ? { origin } : {}),
    body,
  };
}
