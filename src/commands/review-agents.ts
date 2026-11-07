import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { exportReviewAgentResult } from "../review/agents/package-export";
import { ReviewAgentController } from "../review/agents/controller";
import { validateReviewAgentConfig } from "../review/agents/config";
import {
  createReviewPlan,
  createReviewRuntimePlanRegistration,
  type ReviewAssignmentKind,
  type ReviewPlanInput,
  type ReviewRuntimePlanRegistration,
  type ReviewRuntimePlanWaveInput,
} from "../review/agents/planning";
import {
  REVIEW_AGENTS_BRIDGE_RUN_DIR_ENV,
  REVIEW_AGENTS_BRIDGE_SOCKET_ENV,
  REVIEW_AGENTS_BRIDGE_TOKEN_ENV,
  createExternalBridgeCliController,
  createExternalBridgeClientFromEnv,
} from "../review/agents/external-transport";
import {
  REVIEW_AGENTS_ROOT_RUNS_ROOT_ENV,
  REVIEW_AGENTS_ROOT_SOCKET_ENV,
  REVIEW_AGENTS_ROOT_TOKEN_ENV,
  createReviewAgentTerminalCliFactoryFromEnv,
} from "../review/agents/terminal-host";
import type {
  ReviewAgentAdmission,
  ReviewAgentConfig,
  ReviewAgentControllerDependencies,
  ReviewAgentRole,
  ReviewAgentRoleCeiling,
  ReviewAgentRunCeilings,
  ReviewAgentSpawnInput,
} from "../review/agents/types";

const COMMANDS = ["start", "plan", "capabilities", "status", "spawn", "wait", "cancel", "result"] as const;
type ReviewAgentCliCommand = (typeof COMMANDS)[number];

const OPTIONS: Readonly<Record<ReviewAgentCliCommand, readonly string[]>> = {
  start: ["--run-dir", "--run-id", "--revision", "--config"],
  plan: ["--run-dir", "--payload"],
  capabilities: ["--run-dir", "--adapter"],
  status: ["--run-dir", "--dispatch"],
  spawn: ["--run-dir", "--payload"],
  wait: ["--run-dir", "--dispatch"],
  cancel: ["--run-dir", "--dispatch", "--reason"],
  result: ["--run-dir", "--dispatch", "--package"],
};

export interface ReviewAgentCliController {
  capabilities(adapterId?: string): unknown | Promise<unknown>;
  status(dispatchId?: string): unknown | Promise<unknown>;
  spawn(input: ReviewAgentSpawnInput): ReviewAgentAdmission | Promise<ReviewAgentAdmission>;
  wait(dispatchId: string): unknown | Promise<unknown>;
  cancel(dispatchId: string | undefined, reason: string): unknown | Promise<unknown>;
  result(dispatchId: string): unknown | Promise<unknown>;
  close?(): unknown | Promise<unknown>;
}

export interface ReviewAgentCliFactory {
  open(runDir: string): ReviewAgentCliController | Promise<ReviewAgentCliController>;
  create?(runDir: string, input: ReviewAgentCliCreateInput): ReviewAgentCliController | Promise<ReviewAgentCliController>;
  registerPlan?(runDir: string, input: ReviewAgentCliPlanInput): ReviewRuntimePlanRegistration | Promise<ReviewRuntimePlanRegistration>;
}

export interface ReviewAgentCliCreateInput {
  readonly runId: string;
  readonly revision: string;
  readonly config: ReviewAgentConfig;
}

export interface ReviewAgentCliPlanInput {
  readonly plan: ReviewPlanInput;
  readonly waves: readonly ReviewRuntimePlanWaveInput[];
}

export interface ReviewAgentCliDeps {
  readonly factory: ReviewAgentCliFactory;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

interface SpawnPayloadV1 extends ReviewAgentSpawnInput {
  readonly version: 1;
}

interface PlanPayloadV1 extends ReviewAgentCliPlanInput {
  readonly version: 1;
}

const SPAWN_FIELDS = new Set([
  "version",
  "taskId",
  "task",
  "attempt",
  "idempotencyKey",
  "entity",
  "role",
  "adapterId",
  "skillRef",
  "scopeIds",
  "waveId",
  "maxRuntimeMs",
]);
const PLAN_PAYLOAD_FIELDS = new Set(["version", "plan", "waves"]);
const PLAN_FIELDS = new Set(["revision", "planVersion", "areas", "boundaries", "assignments"]);
const AREA_FIELDS = new Set(["id", "title", "requiredAspects", "ownerAssignmentId"]);
const BOUNDARY_FIELDS = new Set(["id", "areaIds", "ownerAssignmentId"]);
const ASSIGNMENT_FIELDS = new Set(["id", "agentInstanceId", "kind", "entity", "parentAssignmentId", "areaIds", "scopeIds", "coverage"]);
const COVERAGE_FIELDS = new Set(["areaId", "scopeId", "aspect"]);
const WAVE_FIELDS = new Set(["waveId", "reviewRound", "assignmentIds"]);
const ASSIGNMENT_KINDS = new Set<ReviewAssignmentKind>(["scout", "coordinator", "worker", "validator"]);
const ROLES = new Set<ReviewAgentRole>(["coordinator", "worker", "scout", "validator"]);
const ADMISSION_FAILURE_CODES = new Set<Extract<ReviewAgentAdmission, { ok: false }>["code"]>([
  "authority_denied",
  "run_closed",
  "adapter_missing",
  "adapter_unsupported",
  "entity_denied",
  "skill_denied",
  "depth_limit",
  "role_violation",
  "launch_limit",
  "wave_limit",
  "general_limit",
  "child_limit",
  "time_limit",
  "invalid_input",
]);
const CONFIG_FIELDS = new Set(["configVersion", "profile", "runCeilings", "roleCeilings", "allowedAdapters", "allowedEntities", "allowedSkills", "fallbackPolicy", "costMode", "spendingCeiling"]);
const RUN_CEILING_FIELDS = ["maxActiveDescendants", "initialConcurrency", "maxIncompleteGenerals", "maxActiveChildrenPerGeneral", "maxLaunches", "maxLaunchesPerWave", "maxLaunchesOutsideWaves", "maxWaves", "maxAgentTimeMs", "elapsedDeadlineMs", "reserveFraction", "maxReviewRounds", "maxDepth"] as const satisfies readonly (keyof ReviewAgentRunCeilings)[];
const ROLE_CEILING_FIELDS = ["elapsedMs", "modelRoundsDefault", "modelRoundsMax", "toolCallsMax", "maxChildLaunches"] as const satisfies readonly (keyof ReviewAgentRoleCeiling)[];
const RUN_CEILING_FIELD_SET: ReadonlySet<string> = new Set(RUN_CEILING_FIELDS);
const ROLE_CEILING_FIELD_SET: ReadonlySet<string> = new Set(ROLE_CEILING_FIELDS);
const CONFIG_ROLES = ["root", "coordinator", "worker", "scout", "validator"] as const;

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function parseArgs(command: ReviewAgentCliCommand, args: readonly string[]): Map<string, string> {
  const accepted = new Set(OPTIONS[command]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}"`);
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!accepted.has(name)) throw new Error(`Unknown option for review agents ${command}: ${name}`);
    if (values.has(name)) throw new Error(`Option ${name} may only be supplied once`);
    const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
    if (value === undefined || value.startsWith("--") || value === "") throw new Error(`${name} needs a value`);
    values.set(name, value);
    if (equals === -1) index += 1;
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAdmission(value: unknown): ReviewAgentAdmission {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("review agents bridge returned an invalid spawn admission");
  }
  if (value.ok) {
    if (typeof value.reused !== "boolean") throw new Error("review agents bridge returned an invalid spawn admission");
    return {
      ok: true,
      dispatchId: nonEmptyString(value.dispatchId, "bridge admission dispatchId"),
      reused: value.reused,
    };
  }
  const code = value.code;
  if (typeof code !== "string" || !ADMISSION_FAILURE_CODES.has(code as Extract<ReviewAgentAdmission, { ok: false }>["code"])) {
    throw new Error("review agents bridge returned an invalid spawn refusal code");
  }
  return {
    ok: false,
    code: code as Extract<ReviewAgentAdmission, { ok: false }>["code"],
    message: nonEmptyString(value.message, "bridge admission message"),
  };
}

function exactFields(record: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, context: string): void {
  const unknown = Object.keys(record).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`${context} has unknown field(s): ${unknown.join(", ")}`);
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates`);
  return value;
}

function positiveInteger(value: unknown, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) < 1)) {
    throw new Error(`${field} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value as number;
}

function parseRunCeilings(value: unknown): ReviewAgentRunCeilings {
  if (!isRecord(value)) throw new Error("runCeilings must be an object");
  exactFields(value, RUN_CEILING_FIELD_SET, "runCeilings");
  const reserveFraction = value.reserveFraction;
  if (typeof reserveFraction !== "number" || !Number.isFinite(reserveFraction) || reserveFraction < 0 || reserveFraction >= 1) {
    throw new Error("runCeilings.reserveFraction must be in [0, 1)");
  }
  return {
    maxActiveDescendants: positiveInteger(value.maxActiveDescendants, "runCeilings.maxActiveDescendants"),
    initialConcurrency: positiveInteger(value.initialConcurrency, "runCeilings.initialConcurrency"),
    maxIncompleteGenerals: positiveInteger(value.maxIncompleteGenerals, "runCeilings.maxIncompleteGenerals"),
    maxActiveChildrenPerGeneral: positiveInteger(value.maxActiveChildrenPerGeneral, "runCeilings.maxActiveChildrenPerGeneral"),
    maxLaunches: positiveInteger(value.maxLaunches, "runCeilings.maxLaunches"),
    maxLaunchesPerWave: positiveInteger(value.maxLaunchesPerWave, "runCeilings.maxLaunchesPerWave"),
    maxLaunchesOutsideWaves: positiveInteger(value.maxLaunchesOutsideWaves, "runCeilings.maxLaunchesOutsideWaves"),
    maxWaves: positiveInteger(value.maxWaves, "runCeilings.maxWaves"),
    maxAgentTimeMs: positiveInteger(value.maxAgentTimeMs, "runCeilings.maxAgentTimeMs"),
    elapsedDeadlineMs: positiveInteger(value.elapsedDeadlineMs, "runCeilings.elapsedDeadlineMs"),
    reserveFraction,
    maxReviewRounds: positiveInteger(value.maxReviewRounds, "runCeilings.maxReviewRounds"),
    maxDepth: positiveInteger(value.maxDepth, "runCeilings.maxDepth"),
  };
}

function parseRoleCeiling(value: unknown, role: (typeof CONFIG_ROLES)[number]): ReviewAgentRoleCeiling {
  if (!isRecord(value)) throw new Error(`roleCeilings.${role} must be an object`);
  exactFields(value, ROLE_CEILING_FIELD_SET, `roleCeilings.${role}`);
  return {
    elapsedMs: positiveInteger(value.elapsedMs, `roleCeilings.${role}.elapsedMs`),
    modelRoundsDefault: positiveInteger(value.modelRoundsDefault, `roleCeilings.${role}.modelRoundsDefault`),
    modelRoundsMax: positiveInteger(value.modelRoundsMax, `roleCeilings.${role}.modelRoundsMax`),
    toolCallsMax: positiveInteger(value.toolCallsMax, `roleCeilings.${role}.toolCallsMax`),
    maxChildLaunches: positiveInteger(value.maxChildLaunches, `roleCeilings.${role}.maxChildLaunches`, true),
  };
}

function parseConfigPayload(value: unknown): ReviewAgentConfig {
  if (!isRecord(value)) throw new Error("review agents config must be a JSON object");
  exactFields(value, CONFIG_FIELDS, "review agents config");
  if (value.configVersion !== 1) throw new Error("configVersion must be 1");
  const profile = nonEmptyString(value.profile, "profile");
  const runCeilings = parseRunCeilings(value.runCeilings);
  if (!isRecord(value.roleCeilings)) throw new Error("roleCeilings must be an object");
  exactFields(value.roleCeilings, new Set(CONFIG_ROLES), "roleCeilings");
  const roleCeilings: ReviewAgentConfig["roleCeilings"] = {
    root: parseRoleCeiling(value.roleCeilings.root, "root"),
    coordinator: parseRoleCeiling(value.roleCeilings.coordinator, "coordinator"),
    worker: parseRoleCeiling(value.roleCeilings.worker, "worker"),
    scout: parseRoleCeiling(value.roleCeilings.scout, "scout"),
    validator: parseRoleCeiling(value.roleCeilings.validator, "validator"),
  };
  const fallbackPolicy = value.fallbackPolicy;
  if (fallbackPolicy !== "refuse" && fallbackPolicy !== "ask" && fallbackPolicy !== "preapproved") throw new Error("fallbackPolicy is invalid");
  const costMode = value.costMode;
  if (costMode !== "measured-cost" && costMode !== "cost-unknown") throw new Error("costMode must be measured-cost or cost-unknown");
  let spendingCeiling: ReviewAgentConfig["spendingCeiling"];
  if (value.spendingCeiling !== undefined) {
    if (!isRecord(value.spendingCeiling)) throw new Error("spendingCeiling must be an object");
    exactFields(value.spendingCeiling, new Set(["amount", "currency"]), "spendingCeiling");
    if (typeof value.spendingCeiling.amount !== "number" || !Number.isFinite(value.spendingCeiling.amount) || value.spendingCeiling.amount <= 0) throw new Error("spendingCeiling.amount must be positive");
    spendingCeiling = { amount: value.spendingCeiling.amount, currency: nonEmptyString(value.spendingCeiling.currency, "spendingCeiling.currency") };
  }
  return validateReviewAgentConfig({
    configVersion: 1,
    profile,
    runCeilings,
    roleCeilings,
    allowedAdapters: stringArray(value.allowedAdapters, "allowedAdapters"),
    allowedEntities: stringArray(value.allowedEntities, "allowedEntities"),
    allowedSkills: stringArray(value.allowedSkills, "allowedSkills"),
    fallbackPolicy,
    costMode,
    ...(spendingCeiling === undefined ? {} : { spendingCeiling }),
  });
}

function optionalString(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return value === undefined ? undefined : nonEmptyString(value, field);
}

function recordArray(value: unknown, field: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) throw new Error(`${field} must be an array of objects`);
  return value;
}

function parsePlanPayload(value: unknown): PlanPayloadV1 {
  if (!isRecord(value)) throw new Error("plan payload must be a JSON object");
  exactFields(value, PLAN_PAYLOAD_FIELDS, "plan payload");
  if (value.version !== 1) throw new Error(`plan payload version must be 1, got ${String(value.version)}`);
  if (!isRecord(value.plan)) throw new Error("plan must be an object");
  const rawPlan = value.plan;
  exactFields(rawPlan, PLAN_FIELDS, "plan");
  const areas = recordArray(rawPlan.areas, "plan.areas").map((area, index) => {
    exactFields(area, AREA_FIELDS, `plan.areas[${index}]`);
    const ownerAssignmentId = optionalString(area, "ownerAssignmentId");
    return {
      id: nonEmptyString(area.id, `plan.areas[${index}].id`),
      title: nonEmptyString(area.title, `plan.areas[${index}].title`),
      requiredAspects: [...stringArray(area.requiredAspects, `plan.areas[${index}].requiredAspects`)],
      ...(ownerAssignmentId === undefined ? {} : { ownerAssignmentId }),
    };
  });
  const boundaries = recordArray(rawPlan.boundaries, "plan.boundaries").map((boundary, index) => {
    exactFields(boundary, BOUNDARY_FIELDS, `plan.boundaries[${index}]`);
    const ownerAssignmentId = optionalString(boundary, "ownerAssignmentId");
    return {
      id: nonEmptyString(boundary.id, `plan.boundaries[${index}].id`),
      areaIds: [...stringArray(boundary.areaIds, `plan.boundaries[${index}].areaIds`)],
      ...(ownerAssignmentId === undefined ? {} : { ownerAssignmentId }),
    };
  });
  const assignments = recordArray(rawPlan.assignments, "plan.assignments").map((assignment, index) => {
    exactFields(assignment, ASSIGNMENT_FIELDS, `plan.assignments[${index}]`);
    const kindValue = nonEmptyString(assignment.kind, `plan.assignments[${index}].kind`);
    if (!ASSIGNMENT_KINDS.has(kindValue as ReviewAssignmentKind)) throw new Error(`plan.assignments[${index}].kind is invalid`);
    const parentAssignmentId = optionalString(assignment, "parentAssignmentId");
    const coverage = recordArray(assignment.coverage, `plan.assignments[${index}].coverage`).map((claim, claimIndex) => {
      exactFields(claim, COVERAGE_FIELDS, `plan.assignments[${index}].coverage[${claimIndex}]`);
      return {
        areaId: nonEmptyString(claim.areaId, `plan.assignments[${index}].coverage[${claimIndex}].areaId`),
        scopeId: nonEmptyString(claim.scopeId, `plan.assignments[${index}].coverage[${claimIndex}].scopeId`),
        aspect: nonEmptyString(claim.aspect, `plan.assignments[${index}].coverage[${claimIndex}].aspect`),
      };
    });
    return {
      id: nonEmptyString(assignment.id, `plan.assignments[${index}].id`),
      agentInstanceId: nonEmptyString(assignment.agentInstanceId, `plan.assignments[${index}].agentInstanceId`),
      kind: kindValue as ReviewAssignmentKind,
      entity: nonEmptyString(assignment.entity, `plan.assignments[${index}].entity`),
      ...(parentAssignmentId === undefined ? {} : { parentAssignmentId }),
      areaIds: [...stringArray(assignment.areaIds, `plan.assignments[${index}].areaIds`)],
      scopeIds: [...stringArray(assignment.scopeIds, `plan.assignments[${index}].scopeIds`)],
      coverage,
    };
  });
  const waves = recordArray(value.waves, "waves").map((wave, index) => {
    exactFields(wave, WAVE_FIELDS, `waves[${index}]`);
    return {
      waveId: nonEmptyString(wave.waveId, `waves[${index}].waveId`),
      reviewRound: positiveInteger(wave.reviewRound, `waves[${index}].reviewRound`),
      assignmentIds: [...stringArray(wave.assignmentIds, `waves[${index}].assignmentIds`)],
    };
  });
  return {
    version: 1,
    plan: {
      revision: nonEmptyString(rawPlan.revision, "plan.revision"),
      planVersion: positiveInteger(rawPlan.planVersion, "plan.planVersion"),
      areas,
      boundaries,
      assignments,
    },
    waves,
  };
}

function parseSpawnPayload(value: unknown): SpawnPayloadV1 {
  if (!isRecord(value)) throw new Error("spawn payload must be a JSON object");
  const unknown = Object.keys(value).filter((field) => !SPAWN_FIELDS.has(field));
  if (unknown.length > 0) throw new Error(`spawn payload has unknown field(s): ${unknown.join(", ")}`);
  if (value.version !== 1) throw new Error(`spawn payload version must be 1, got ${String(value.version)}`);
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) throw new Error("attempt must be a positive integer");
  const role = nonEmptyString(value.role, "role") as ReviewAgentRole;
  if (!ROLES.has(role)) throw new Error(`role must be one of: ${[...ROLES].join(", ")}`);
  if (!Array.isArray(value.scopeIds) || value.scopeIds.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error("scopeIds must be an array of non-empty strings");
  }
  if (value.maxRuntimeMs !== undefined && (!Number.isSafeInteger(value.maxRuntimeMs) || (value.maxRuntimeMs as number) <= 0)) {
    throw new Error("maxRuntimeMs must be a positive integer");
  }
  return {
    version: 1,
    taskId: nonEmptyString(value.taskId, "taskId"),
    ...(optionalString(value, "task") === undefined ? {} : { task: optionalString(value, "task")! }),
    attempt: value.attempt as number,
    ...(optionalString(value, "idempotencyKey") === undefined ? {} : { idempotencyKey: optionalString(value, "idempotencyKey")! }),
    entity: nonEmptyString(value.entity, "entity"),
    role,
    adapterId: nonEmptyString(value.adapterId, "adapterId"),
    ...(optionalString(value, "skillRef") === undefined ? {} : { skillRef: optionalString(value, "skillRef")! }),
    scopeIds: value.scopeIds as string[],
    ...(optionalString(value, "waveId") === undefined ? {} : { waveId: optionalString(value, "waveId")! }),
    ...(value.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: value.maxRuntimeMs as number }),
  };
}

async function readContainedJson(runDir: string, payloadFile: string, label: string): Promise<unknown> {
  const [realRunDir, realPayload] = await Promise.all([realpath(runDir), realpath(path.resolve(payloadFile))]);
  const relative = path.relative(realRunDir, realPayload);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--payload must name a file inside --run-dir");
  }
  try {
    return JSON.parse(await readFile(realPayload, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} payload: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function readContainedSpawnPayload(runDir: string, payloadFile: string): Promise<SpawnPayloadV1> {
  return parseSpawnPayload(await readContainedJson(runDir, payloadFile, "spawn"));
}

async function readContainedPlanPayload(runDir: string, payloadFile: string): Promise<PlanPayloadV1> {
  return parsePlanPayload(await readContainedJson(runDir, payloadFile, "plan"));
}

async function readConfigFile(configFile: string): Promise<ReviewAgentConfig> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path.resolve(configFile), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read review agents config: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return parseConfigPayload(decoded);
}

function assertSubset(requested: readonly string[] | undefined, ceiling: readonly string[] | undefined, field: string): void {
  const allowed = new Set(ceiling ?? []);
  const over = (requested ?? []).filter((item) => !allowed.has(item));
  if (over.length > 0) throw new Error(`${field} exceeds host ceiling: ${over.join(", ")}`);
}

function assertWithinHostCeiling(requested: ReviewAgentConfig, ceiling: ReviewAgentConfig): void {
  if (requested.profile !== ceiling.profile) throw new Error(`profile exceeds host ceiling: ${requested.profile}`);
  for (const field of RUN_CEILING_FIELDS) {
    if (requested.runCeilings[field] > ceiling.runCeilings[field]) throw new Error(`runCeilings.${field} exceeds host ceiling`);
  }
  for (const role of CONFIG_ROLES) {
    for (const field of ROLE_CEILING_FIELDS) {
      if (requested.roleCeilings[role][field] > ceiling.roleCeilings[role][field]) throw new Error(`roleCeilings.${role}.${field} exceeds host ceiling`);
    }
  }
  assertSubset(requested.allowedAdapters, ceiling.allowedAdapters, "allowedAdapters");
  assertSubset(requested.allowedEntities, ceiling.allowedEntities, "allowedEntities");
  assertSubset(requested.allowedSkills, ceiling.allowedSkills, "allowedSkills");
  if (requested.fallbackPolicy !== ceiling.fallbackPolicy) throw new Error("fallbackPolicy must match the host ceiling");
  if (requested.costMode !== ceiling.costMode) throw new Error("costMode must match the host ceiling");
  if (requested.costMode === "measured-cost") {
    const requestedSpend = requested.spendingCeiling;
    const ceilingSpend = ceiling.spendingCeiling;
    if (requestedSpend === undefined || ceilingSpend === undefined || requestedSpend.currency !== ceilingSpend.currency || requestedSpend.amount > ceilingSpend.amount) {
      throw new Error("spendingCeiling exceeds host ceiling");
    }
  }
}

/**
 * The default remains fail-closed until the shell/session host supplies its
 * live adapters and authority. Opening persisted state alone must never mint
 * authority or silently turn a status-only CLI into an execution runtime.
 */
export function createReviewAgentCliFactory(
  host: Pick<ReviewAgentControllerDependencies, "adapters" | "authority" | "entityPolicies" | "clock" | "id" | "ownerId" | "leaseMs"> & {
    readonly configCeiling?: ReviewAgentConfig;
  },
): ReviewAgentCliFactory {
  const controllers = new Map<string, Promise<ReviewAgentController>>();
  const open = (storageDir: string): Promise<ReviewAgentController> => {
    const key = path.resolve(storageDir);
    const existing = controllers.get(key);
    if (existing !== undefined) return existing;
    const pending = ReviewAgentController.open({
      storageDir: key,
      adapters: host.adapters,
      authority: host.authority,
      ...(host.entityPolicies === undefined ? {} : { entityPolicies: host.entityPolicies }),
      ...(host.clock === undefined ? {} : { clock: host.clock }),
      ...(host.id === undefined ? {} : { id: host.id }),
      ...(host.ownerId === undefined ? {} : { ownerId: host.ownerId }),
      ...(host.leaseMs === undefined ? {} : { leaseMs: host.leaseMs }),
    });
    controllers.set(key, pending);
    void pending.catch(() => controllers.delete(key));
    return pending;
  };
  return {
    open,
    create: host.configCeiling === undefined
      ? async () => { throw new Error("review agents start unavailable: host config ceiling is not bound"); }
      : async (storageDir, input) => {
          const ownerId = host.ownerId;
          if (ownerId === undefined || ownerId.trim() === "") throw new Error("review agents start unavailable: host ownerId is not bound");
          assertWithinHostCeiling(input.config, host.configCeiling!);
          const key = path.resolve(storageDir);
          if (controllers.has(key)) throw new Error(`review agents run is already open: ${key}`);
          const pending = ReviewAgentController.create({
            storageDir: key,
            runId: input.runId,
            revision: input.revision,
            config: input.config,
            adapters: host.adapters,
            authority: host.authority,
            ...(host.entityPolicies === undefined ? {} : { entityPolicies: host.entityPolicies }),
            ...(host.clock === undefined ? {} : { clock: host.clock }),
            ...(host.id === undefined ? {} : { id: host.id }),
            ownerId,
            ...(host.leaseMs === undefined ? {} : { leaseMs: host.leaseMs }),
          });
          controllers.set(key, pending);
          void pending.catch(() => controllers.delete(key));
          return pending;
        },
    ...(host.ownerId === undefined || host.ownerId.trim() === ""
      ? {}
      : {
          registerPlan: async (storageDir: string, input: ReviewAgentCliPlanInput) => {
            const plan = createReviewPlan(input.plan);
            const registration = createReviewRuntimePlanRegistration(plan, input.waves);
            const controller = await open(storageDir);
            await controller.registerPlan(registration);
            return registration;
          },
        }),
  };
}

/**
 * A direct terminal invocation can inspect durable status and capabilities,
 * but cannot spawn, cancel or read results until a shell/session host binds
 * live authority. This binding grants nothing implicitly.
 */
export const statusOnlyReviewAgentCliFactory = createReviewAgentCliFactory({
  adapters: [],
  authority: { authorize: () => false },
});

export function reviewAgentsCliFactoryFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReviewAgentCliFactory {
  const rootKeys = [REVIEW_AGENTS_ROOT_SOCKET_ENV, REVIEW_AGENTS_ROOT_TOKEN_ENV, REVIEW_AGENTS_ROOT_RUNS_ROOT_ENV];
  const bridgeKeys = [REVIEW_AGENTS_BRIDGE_SOCKET_ENV, REVIEW_AGENTS_BRIDGE_TOKEN_ENV, REVIEW_AGENTS_BRIDGE_RUN_DIR_ENV];
  const hasRootEnvironment = rootKeys.some((key) => env[key] !== undefined);
  const hasBridgeEnvironment = bridgeKeys.some((key) => env[key] !== undefined);
  if (hasRootEnvironment && hasBridgeEnvironment) throw new Error("review agents root and descendant bridge environments cannot be combined");
  if (hasRootEnvironment) return createReviewAgentTerminalCliFactoryFromEnv(env);
  if (!hasBridgeEnvironment) return statusOnlyReviewAgentCliFactory;
  return {
    async open(requestedRunDir) {
      const { client, runDir } = createExternalBridgeClientFromEnv(env);
      const [requested, granted] = await Promise.all([realpath(requestedRunDir), realpath(runDir)]);
      if (requested !== granted) throw new Error("--run-dir does not match the scoped review agents bridge grant");
      const bridge = createExternalBridgeCliController(client);
      return {
        capabilities: bridge.capabilities,
        status: bridge.status,
        spawn: async (input) => parseAdmission(await bridge.spawn(input)),
        wait: bridge.wait,
        cancel: bridge.cancel,
        result: bridge.result,
      };
    },
  };
}

export async function runReviewAgentsCommand(args: readonly string[], deps: ReviewAgentCliDeps): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  try {
    const command = args[0];
    if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
      throw new Error(`review agents command must be one of: ${COMMANDS.join(", ")}`);
    }
    const typedCommand = command as ReviewAgentCliCommand;
    const values = parseArgs(typedCommand, args.slice(1));
    const runDir = path.resolve(required(values, "--run-dir"));

    // Parse and validate all user-controlled payload data before the factory
    // can open a run or acquire host authority.
    const payload = typedCommand === "spawn"
      ? await readContainedSpawnPayload(runDir, required(values, "--payload"))
      : undefined;
    const planPayload = typedCommand === "plan"
      ? await readContainedPlanPayload(runDir, required(values, "--payload"))
      : undefined;
    const createInput = typedCommand === "start"
      ? {
          runId: nonEmptyString(required(values, "--run-id"), "--run-id"),
          revision: nonEmptyString(required(values, "--revision"), "--revision"),
          config: await readConfigFile(required(values, "--config")),
        }
      : undefined;
    if ((typedCommand === "wait" || typedCommand === "result") && !values.has("--dispatch")) {
      throw new Error(`--dispatch is required for ${typedCommand}`);
    }

    if (typedCommand === "plan") {
      if (deps.factory.registerPlan === undefined) throw new Error("review agents plan unavailable: host has no plan-registration binding");
      const { version: _version, ...input } = planPayload!;
      log(JSON.stringify(await deps.factory.registerPlan(runDir, input)));
      return 0;
    }

    const controller = typedCommand === "start"
      ? await (() => {
          if (deps.factory.create === undefined) throw new Error("review agents start unavailable: host has no create binding");
          return deps.factory.create(runDir, createInput!);
        })()
      : await deps.factory.open(runDir);
    let result: unknown;
    let exitCode = 0;
    switch (typedCommand) {
      case "start":
        result = await controller.status();
        break;
      case "capabilities":
        result = await controller.capabilities(values.get("--adapter"));
        break;
      case "status":
        result = await controller.status(values.get("--dispatch"));
        break;
      case "spawn": {
        const { version: _version, ...input } = payload!;
        const admission = await controller.spawn(input);
        result = admission;
        if (!admission.ok) exitCode = 1;
        break;
      }
      case "wait":
        result = await controller.wait(values.get("--dispatch")!);
        break;
      case "cancel":
        result = await controller.cancel(values.get("--dispatch"), values.get("--reason") ?? "operator requested cancellation");
        break;
      case "result":
        result = await controller.result(values.get("--dispatch")!);
        if (values.has("--package")) {
          if (!isRecord(result) || result.dispatchId !== values.get("--dispatch")) throw new Error("No authorized result for requested dispatch");
          const exported = await exportReviewAgentResult(values.get("--package")!, result);
          if (!exported.ok) throw exported.error;
          result = exported.value;
        }
        break;
    }
    log(JSON.stringify(result));
    return exitCode;
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

export async function runReviewAgents(
  args: readonly string[],
  factory?: ReviewAgentCliFactory,
): Promise<void> {
  const code = await runReviewAgentsCommand(args, { factory: factory ?? reviewAgentsCliFactoryFromEnv() });
  if (code !== 0) process.exitCode = code;
}
