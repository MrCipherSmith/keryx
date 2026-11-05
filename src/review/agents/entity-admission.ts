import type { AgentCatalog } from "../../agents/catalog";
import type { AgentDefinition, AgentExecutionKind, AgentToolScope } from "../../agents/types";
import type { ReviewAgentEntityPolicy, ReviewAgentEntityPolicyResolver, ReviewAgentRole } from "./types";

export type ReviewAgentSourceAction = "read-source" | "write-source" | "write-result";

export interface ReviewAgentEntityAdmissionRequest {
  readonly entity: string;
  readonly requestedRole: ReviewAgentRole;
  readonly allowedEntities: readonly string[];
  readonly allowedSkills: readonly string[];
  readonly skillRef?: string;
  readonly parentEntity?: string;
}

export interface ReviewAgentEntityBinding {
  readonly entity: string;
  readonly role: ReviewAgentRole;
  readonly executionKind: AgentExecutionKind;
  readonly toolScope: AgentToolScope;
  readonly tools: readonly string[];
  readonly skillRef?: string;
  readonly allowedSkills: readonly string[];
  readonly allowedChildren: readonly string[];
  readonly delegation: {
    readonly allowed_entities: readonly string[];
    readonly max_depth: number;
    readonly max_children: number;
  };
  readonly legacyDefinition: boolean;
  readonly sourcePolicy: {
    readonly sourceRead: true;
    readonly sourceWrite: false;
    readonly resultWrite: true;
    /** Definitions declare intent; the selected adapter must still prove enforcement. */
    readonly enforcement: "adapter-required";
  };
}

export type ReviewAgentEntityAdmissionFailureCode =
  | "entity_not_found"
  | "entity_not_allowed_by_run"
  | "role_mismatch"
  | "parent_not_found"
  | "parent_not_orchestrator"
  | "child_entity_denied"
  | "general_child_denied"
  | "skill_not_allowed_by_run"
  | "skill_not_allowed_by_entity"
  | "source_policy_unsupported"
  | "invalid_entity_contract"
  | "source_write_denied";

export interface ReviewAgentEntityAdmissionFailure {
  readonly ok: false;
  readonly disposition: "denied" | "unsupported";
  readonly code: ReviewAgentEntityAdmissionFailureCode;
  readonly message: string;
}

export type ReviewAgentEntityAdmissionResult =
  | { readonly ok: true; readonly binding: ReviewAgentEntityBinding }
  | ReviewAgentEntityAdmissionFailure;

const SOURCE_MUTATION_TOOLS = new Set(["apply_patch", "shell_exec"]);
const LEAF_DELEGATION = { allowed_entities: [], max_depth: 0, max_children: 0 } as const;
const SOURCE_POLICY = {
  sourceRead: true,
  sourceWrite: false,
  resultWrite: true,
  enforcement: "adapter-required",
} as const;

function fail(
  disposition: ReviewAgentEntityAdmissionFailure["disposition"],
  code: ReviewAgentEntityAdmissionFailureCode,
  message: string,
): ReviewAgentEntityAdmissionFailure {
  return { ok: false, disposition, code, message };
}

function exactDefinition(catalog: AgentCatalog, name: string): AgentDefinition | undefined {
  return catalog.agents.find((agent) => agent.definition.name === name)?.definition;
}

function normalizedKind(definition: AgentDefinition): AgentExecutionKind {
  return definition.execution_kind ?? "worker";
}

function normalizedToolScope(definition: AgentDefinition): AgentToolScope {
  return definition.tool_scope ?? "static";
}

function normalizedDelegation(definition: AgentDefinition): ReviewAgentEntityBinding["delegation"] {
  const value = definition.delegation ?? LEAF_DELEGATION;
  return {
    allowed_entities: [...value.allowed_entities],
    max_depth: value.max_depth,
    max_children: value.max_children,
  };
}

function derivedRole(definition: AgentDefinition): ReviewAgentRole {
  if (normalizedKind(definition) === "orchestrator") return "coordinator";
  if (definition.name === "review-scout") return "scout";
  if (definition.name === "review-validator") return "validator";
  return "worker";
}

function contractFailure(definition: AgentDefinition): ReviewAgentEntityAdmissionFailure | undefined {
  if (definition.policy_profile !== "read-only") {
    return fail(
      "unsupported",
      "source_policy_unsupported",
      `Entity ${definition.name} declares ${definition.policy_profile}; review agents cannot silently narrow it to read-only`,
    );
  }
  const mutationTool = definition.tools.find((tool) => SOURCE_MUTATION_TOOLS.has(tool));
  if (mutationTool !== undefined) {
    return fail(
      "unsupported",
      "invalid_entity_contract",
      `Read-only entity ${definition.name} declares source-mutation-capable tool ${mutationTool}`,
    );
  }

  const kind = normalizedKind(definition);
  const scope = normalizedToolScope(definition);
  const delegation = normalizedDelegation(definition);
  const delegates = delegation.allowed_entities.length > 0 || delegation.max_depth > 0 || delegation.max_children > 0;
  if (kind === "worker" && (scope !== "static" || delegates || definition.tools.includes("spawn_subagent"))) {
    return fail("unsupported", "invalid_entity_contract", `Leaf entity ${definition.name} cannot delegate or inherit parent tools`);
  }
  if (kind === "orchestrator") {
    if (definition.schema_version !== 2) {
      return fail("unsupported", "invalid_entity_contract", `Legacy entity ${definition.name} cannot acquire orchestrator authority`);
    }
    if (!delegates || scope !== "parent" || !definition.tools.includes("spawn_subagent")) {
      return fail("unsupported", "invalid_entity_contract", `Coordinator ${definition.name} has an incomplete delegation contract`);
    }
  }
  return undefined;
}

export function resolveReviewAgentEntityAdmission(
  catalog: AgentCatalog,
  request: ReviewAgentEntityAdmissionRequest,
): ReviewAgentEntityAdmissionResult {
  const definition = exactDefinition(catalog, request.entity);
  if (definition === undefined) return fail("denied", "entity_not_found", `Entity ${request.entity} is not in the catalog`);
  if (!request.allowedEntities.includes(definition.name)) {
    return fail("denied", "entity_not_allowed_by_run", `Entity ${definition.name} is not allowed by this review run`);
  }

  const invalid = contractFailure(definition);
  if (invalid !== undefined) return invalid;
  const role = derivedRole(definition);
  if (request.requestedRole !== role) {
    return fail(
      "denied",
      "role_mismatch",
      `Requested role ${request.requestedRole} does not match catalog-derived role ${role} for ${definition.name}`,
    );
  }

  if (request.parentEntity !== undefined) {
    const parent = exactDefinition(catalog, request.parentEntity);
    if (parent === undefined) return fail("denied", "parent_not_found", `Parent entity ${request.parentEntity} is not in the catalog`);
    const parentInvalid = contractFailure(parent);
    if (parentInvalid !== undefined) return parentInvalid;
    if (normalizedKind(parent) !== "orchestrator") {
      return fail("denied", "parent_not_orchestrator", `Entity ${parent.name} cannot spawn children`);
    }
    if (normalizedKind(definition) === "orchestrator") {
      return fail("denied", "general_child_denied", "Review agents permits only leaf children below a coordinator");
    }
    if (!normalizedDelegation(parent).allowed_entities.includes(definition.name)) {
      return fail("denied", "child_entity_denied", `${parent.name} does not allow child entity ${definition.name}`);
    }
  }

  if (request.skillRef !== undefined) {
    if (!request.allowedSkills.includes(request.skillRef)) {
      return fail("denied", "skill_not_allowed_by_run", `Skill ${request.skillRef} is not allowed by this review run`);
    }
    if (!definition.skills.includes(request.skillRef)) {
      return fail("denied", "skill_not_allowed_by_entity", `Entity ${definition.name} does not allow skill ${request.skillRef}`);
    }
  }

  const delegation = normalizedDelegation(definition);
  return {
    ok: true,
    binding: {
      entity: definition.name,
      role,
      executionKind: normalizedKind(definition),
      toolScope: normalizedToolScope(definition),
      tools: [...definition.tools],
      ...(request.skillRef === undefined ? {} : { skillRef: request.skillRef }),
      allowedSkills: [...definition.skills],
      allowedChildren: [...delegation.allowed_entities],
      delegation,
      legacyDefinition: definition.schema_version !== 2,
      sourcePolicy: SOURCE_POLICY,
    },
  };
}

/** Adapter for the controller's existing entity-policy port. Run allowlists remain controller-owned. */
export function createReviewAgentEntityPolicyResolver(catalog: AgentCatalog): ReviewAgentEntityPolicyResolver {
  return {
    resolve(entity: string): ReviewAgentEntityPolicy | undefined {
      const definition = exactDefinition(catalog, entity);
      if (definition === undefined || contractFailure(definition) !== undefined) return undefined;
      return {
        name: definition.name,
        role: derivedRole(definition),
        allowedSkills: [...definition.skills],
        allowedChildren: [...normalizedDelegation(definition).allowed_entities],
      };
    },
  };
}

export function authorizeReviewAgentSourceAction(
  action: ReviewAgentSourceAction,
): { readonly ok: true } | ReviewAgentEntityAdmissionFailure {
  if (action !== "write-source") return { ok: true };
  return fail("denied", "source_write_denied", "Review agents entities may read source and write results, but may not write source");
}
