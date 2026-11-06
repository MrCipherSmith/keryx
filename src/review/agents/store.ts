import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../../lib/fs";
import { validateReviewAgentConfig } from "./config";
import {
  REVIEW_AGENTS_STATE_VERSION,
  type ReviewAgentAssignmentRecord,
  type ReviewAgentCoverageRecord,
  type ReviewAgentRunState,
  type ReviewAgentStoredResult,
} from "./types";

export const REVIEW_AGENTS_STATE_FILE = "review-agents-state.json";

function statePath(storageDir: string): string { return path.join(storageDir, REVIEW_AGENTS_STATE_FILE); }
function lockPath(storageDir: string): string { return path.join(storageDir, ".review-agents-state.lock"); }

const ASSIGNMENT_STATUSES = new Set([
  "queued", "running", "waiting_children", "collecting", "cancelling",
  "completed", "blocked", "failed", "cancelled", "unresolved",
]);
const ROLES = new Set(["coordinator", "worker", "scout", "validator"]);
const TERMINAL = new Set(["completed", "blocked", "failed", "cancelled", "unresolved"]);

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`);
  return value as number;
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`${name} must be an array of non-empty strings`);
  if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicates`);
  return value;
}
function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}
function exactFields(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(record)) if (!known.has(key)) throw new Error(`${name} has unknown field ${key}`);
}

/** Refuse values JSON would silently drop or coerce before they reach durable state. */
function jsonSafe(value: unknown, name: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${name} contains a non-JSON value`);
  if (seen.has(value)) throw new Error(`${name} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => jsonSafe(entry, `${name}[${index}]`, seen));
  else for (const [key, entry] of Object.entries(value)) jsonSafe(entry, `${name}.${key}`, seen);
  seen.delete(value);
}

function validateAssignment(key: string, value: unknown, config: ReviewAgentRunState["config"]): ReviewAgentAssignmentRecord {
  const record = object(value, `assignments.${key}`);
  exactFields(record, [
    "dispatchId", "taskId", "task", "attempt", "idempotencyKey", "entity", "role", "adapterId", "skillRef",
    "scopeIds", "waveId", "planHash", "planVersion", "coverageCells", "budgetClass", "parentDispatchId", "authorityRef", "depth", "status", "children",
    "reservationMs", "requestedRuntimeMs", "selectedModelRounds", "usedActiveMs", "activeStartedAt", "createdAt", "updatedAt",
    "resultId", "error", "cancelReason",
  ], `assignments.${key}`);
  if (text(record.dispatchId, `assignments.${key}.dispatchId`) !== key) throw new Error(`assignments.${key}.dispatchId must match its key`);
  text(record.taskId, `assignments.${key}.taskId`); text(record.task, `assignments.${key}.task`);
  integer(record.attempt, `assignments.${key}.attempt`, 1); text(record.idempotencyKey, `assignments.${key}.idempotencyKey`);
  text(record.entity, `assignments.${key}.entity`); text(record.adapterId, `assignments.${key}.adapterId`);
  if (!ROLES.has(String(record.role))) throw new Error(`assignments.${key}.role is invalid`);
  if (!ASSIGNMENT_STATUSES.has(String(record.status))) throw new Error(`assignments.${key}.status is invalid`);
  optionalText(record.skillRef, `assignments.${key}.skillRef`); stringArray(record.scopeIds, `assignments.${key}.scopeIds`);
  optionalText(record.waveId, `assignments.${key}.waveId`); optionalText(record.planHash, `assignments.${key}.planHash`);
  if ((record.planHash === undefined) !== (record.planVersion === undefined)) throw new Error(`assignments.${key} has incomplete plan binding`);
  if (record.planVersion !== undefined) integer(record.planVersion, `assignments.${key}.planVersion`, 1);
  if ((record.planHash === undefined) !== (record.coverageCells === undefined)) throw new Error(`assignments.${key} has incomplete plan coverage binding`);
  if (record.coverageCells !== undefined) {
    if (!Array.isArray(record.coverageCells)) throw new Error(`assignments.${key}.coverageCells must be an array`);
    const cells = new Set<string>();
    for (const [index, rawCell] of record.coverageCells.entries()) {
      const cell = object(rawCell, `assignments.${key}.coverageCells[${index}]`); exactFields(cell, ["scopeId", "aspect"], `assignments.${key}.coverageCells[${index}]`);
      const scopeId = text(cell.scopeId, `assignments.${key}.coverageCells[${index}].scopeId`); const aspect = text(cell.aspect, `assignments.${key}.coverageCells[${index}].aspect`);
      if (!(record.scopeIds as string[]).includes(scopeId) || cells.has(`${scopeId}\u0000${aspect}`)) throw new Error(`assignments.${key}.coverageCells is invalid`); cells.add(`${scopeId}\u0000${aspect}`);
    }
  }
  optionalText(record.parentDispatchId, `assignments.${key}.parentDispatchId`); optionalText(record.authorityRef, `assignments.${key}.authorityRef`);
  if (record.budgetClass !== "ordinary" && record.budgetClass !== "reserved") throw new Error(`assignments.${key}.budgetClass is invalid`);
  const depth = integer(record.depth, `assignments.${key}.depth`, 1);
  if (depth > config.runCeilings.maxDepth) throw new Error(`assignments.${key}.depth exceeds the run ceiling`);
  const children = stringArray(record.children, `assignments.${key}.children`);
  if (record.role !== "coordinator" && children.length > 0) throw new Error(`assignments.${key} is a leaf but has children`);
  const reservation = integer(record.reservationMs, `assignments.${key}.reservationMs`);
  const requestedRuntime = integer(record.requestedRuntimeMs, `assignments.${key}.requestedRuntimeMs`, 1);
  if (requestedRuntime > config.roleCeilings[String(record.role) as keyof typeof config.roleCeilings].elapsedMs || reservation > requestedRuntime) throw new Error(`assignments.${key} has an invalid runtime reservation`);
  const selectedModelRounds = integer(record.selectedModelRounds, `assignments.${key}.selectedModelRounds`, 1);
  if (selectedModelRounds > config.roleCeilings[String(record.role) as keyof typeof config.roleCeilings].modelRoundsMax) throw new Error(`assignments.${key}.selectedModelRounds exceeds its role ceiling`);
  integer(record.usedActiveMs, `assignments.${key}.usedActiveMs`);
  optionalText(record.activeStartedAt, `assignments.${key}.activeStartedAt`);
  if (record.activeStartedAt !== undefined) timestamp(record.activeStartedAt, `assignments.${key}.activeStartedAt`);
  timestamp(record.createdAt, `assignments.${key}.createdAt`); timestamp(record.updatedAt, `assignments.${key}.updatedAt`);
  optionalText(record.resultId, `assignments.${key}.resultId`); optionalText(record.error, `assignments.${key}.error`); optionalText(record.cancelReason, `assignments.${key}.cancelReason`);
  if (record.status === "waiting_children" && record.role !== "coordinator") throw new Error(`assignments.${key} is a non-coordinator waiting for children`);
  if (record.status === "completed" && record.resultId === undefined) throw new Error(`assignments.${key} completed without a result`);
  if (record.status !== "completed" && record.resultId !== undefined) throw new Error(`assignments.${key} has a result outside completed status`);
  if (!["running", "collecting", "cancelling"].includes(String(record.status)) && record.activeStartedAt !== undefined) throw new Error(`assignments.${key} has an active segment in status ${String(record.status)}`);
  return value as ReviewAgentAssignmentRecord;
}

function validateResult(key: string, value: unknown, state: ReviewAgentRunState): ReviewAgentStoredResult {
  const record = object(value, `results.${key}`);
  exactFields(record, ["resultId", "dispatchId", "runId", "taskId", "attempt", "revision", "planHash", "planVersion", "entity", "skillRef", "scopeIds", "content", "usage", "metadata", "createdAt"], `results.${key}`);
  if (text(record.resultId, `results.${key}.resultId`) !== key) throw new Error(`results.${key}.resultId must match its key`);
  const dispatchId = text(record.dispatchId, `results.${key}.dispatchId`);
  const assignment = state.assignments[dispatchId];
  if (assignment === undefined) throw new Error(`results.${key} references an unknown assignment`);
  if (record.runId !== state.runId || record.revision !== state.revision || record.taskId !== assignment.taskId || record.attempt !== assignment.attempt || record.entity !== assignment.entity) throw new Error(`results.${key} does not match its assignment/run snapshot`);
  if (record.planHash !== assignment.planHash || record.planVersion !== assignment.planVersion) throw new Error(`results.${key} does not match its assignment plan`);
  const scopes = stringArray(record.scopeIds, `results.${key}.scopeIds`);
  if (JSON.stringify(scopes) !== JSON.stringify(assignment.scopeIds)) throw new Error(`results.${key}.scopeIds do not match its assignment`);
  if (record.skillRef !== assignment.skillRef) throw new Error(`results.${key}.skillRef does not match its assignment`);
  if (!("content" in record)) throw new Error(`results.${key}.content is missing`);
  jsonSafe(record.content, `results.${key}.content`); if (record.usage !== undefined) jsonSafe(record.usage, `results.${key}.usage`); if (record.metadata !== undefined) jsonSafe(record.metadata, `results.${key}.metadata`);
  timestamp(record.createdAt, `results.${key}.createdAt`);
  if (assignment.resultId !== key || assignment.status !== "completed") throw new Error(`results.${key} is not the completed assignment result`);
  return value as ReviewAgentStoredResult;
}

function validateCoverage(key: string, value: unknown, state: ReviewAgentRunState): ReviewAgentCoverageRecord {
  const record = object(value, `coverage.${key}`);
  exactFields(record, ["key", "scopeId", "aspect", "dispatchId", "status", "resultId", "evidence", "planHash", "planVersion", "recordedAt"], `coverage.${key}`);
  const scopeId = text(record.scopeId, `coverage.${key}.scopeId`); const aspect = text(record.aspect, `coverage.${key}.aspect`);
  if (record.key !== key || key !== `${scopeId}\u0000${aspect}`) throw new Error(`coverage.${key}.key is inconsistent`);
  const dispatchId = text(record.dispatchId, `coverage.${key}.dispatchId`); const assignment = state.assignments[dispatchId];
  if (assignment === undefined || !assignment.scopeIds.includes(scopeId)) throw new Error(`coverage.${key} is outside its assignment scope`);
  if (!TERMINAL.has(assignment.status)) throw new Error(`coverage.${key} references a non-terminal assignment`);
  if (record.status !== "result" && record.status !== "blocked" && record.status !== "not_run") throw new Error(`coverage.${key}.status is invalid`);
  optionalText(record.resultId, `coverage.${key}.resultId`); timestamp(record.recordedAt, `coverage.${key}.recordedAt`);
  optionalText(record.planHash, `coverage.${key}.planHash`); if (record.planVersion !== undefined) integer(record.planVersion, `coverage.${key}.planVersion`, 1);
  if (record.planHash !== assignment.planHash || record.planVersion !== assignment.planVersion) throw new Error(`coverage.${key} does not match its assignment plan`);
  if (state.activePlan !== null && (record.planHash !== state.activePlan.planHash || record.planVersion !== state.activePlan.planVersion || !assignment.coverageCells?.some((cell) => cell.scopeId === scopeId && cell.aspect === aspect))) throw new Error(`coverage.${key} is stale or outside the active plan`);
  if (record.evidence !== undefined) stringArray(record.evidence, `coverage.${key}.evidence`);
  if (record.status === "result") {
    if (assignment.status !== "completed" || assignment.resultId === undefined || record.resultId !== assignment.resultId) throw new Error(`coverage.${key} claims a result without the completed assignment result`);
    if (!Array.isArray(record.evidence) || record.evidence.length === 0) throw new Error(`coverage.${key} result has no evidence`);
  } else if (record.resultId !== undefined || record.evidence !== undefined) throw new Error(`coverage.${key} ${String(record.status)} must not carry result evidence`);
  return value as ReviewAgentCoverageRecord;
}

export function validateReviewAgentState(value: unknown): ReviewAgentRunState {
  jsonSafe(value, "Review agents state");
  const raw = object(value, "Review agents state");
  exactFields(raw, [
    "schemaVersion", "runId", "revision", "config", "status", "createdAt", "updatedAt", "controllerLease", "activePlan", "highestReviewRound",
    "usedLaunches", "outsideWaveLaunches", "usedActiveAgentTimeMs", "reservedAgentTimeMs", "waveLaunches", "registeredWaves",
    "assignments", "idempotency", "results", "coverage",
  ], "Review agents state");
  const record = value as Partial<ReviewAgentRunState>;
  if (record.schemaVersion !== REVIEW_AGENTS_STATE_VERSION) throw new Error(`Unsupported review agents state version: ${String(record.schemaVersion)}`);
  text(record.runId, "runId"); text(record.revision, "revision");
  if (record.config === undefined) throw new Error("Review agents state has no config");
  validateReviewAgentConfig(record.config);
  if (!("activePlan" in raw)) throw new Error("Review agents state has no activePlan field");
  if (record.activePlan !== null) {
    const plan = object(record.activePlan, "activePlan");
    exactFields(plan, ["planHash", "planVersion", "revision", "registeredAt", "waves", "assignments"], "activePlan");
    const planHash = text(plan.planHash, "activePlan.planHash"); integer(plan.planVersion, "activePlan.planVersion", 1);
    if (plan.revision !== record.revision) throw new Error("activePlan.revision must match the run revision");
    timestamp(plan.registeredAt, "activePlan.registeredAt");
    const waves = object(plan.waves, "activePlan.waves");
    if (Object.keys(waves).length > record.config.runCeilings.maxWaves) throw new Error("activePlan exceeds maxWaves");
    for (const [waveId, rawWave] of Object.entries(waves)) {
      const wave = object(rawWave, `activePlan.waves.${waveId}`); exactFields(wave, ["waveId", "planHash", "reviewRound", "registeredAt"], `activePlan.waves.${waveId}`);
      if (text(wave.waveId, `activePlan.waves.${waveId}.waveId`) !== waveId || wave.planHash !== planHash) throw new Error(`activePlan.waves.${waveId} is inconsistent`);
      if (integer(wave.reviewRound, `activePlan.waves.${waveId}.reviewRound`, 1) > record.config.runCeilings.maxReviewRounds) throw new Error(`activePlan.waves.${waveId} exceeds maxReviewRounds`);
      timestamp(wave.registeredAt, `activePlan.waves.${waveId}.registeredAt`);
    }
    const assignments = object(plan.assignments, "activePlan.assignments");
    for (const [taskId, rawBinding] of Object.entries(assignments)) {
      const binding = object(rawBinding, `activePlan.assignments.${taskId}`); exactFields(binding, ["taskId", "parentTaskId", "entity", "role", "scopeIds", "waveId", "coverage", "delegatedCoverage", "allowDynamicChildren"], `activePlan.assignments.${taskId}`);
      if (text(binding.taskId, `activePlan.assignments.${taskId}.taskId`) !== taskId) throw new Error(`activePlan.assignments.${taskId} taskId is inconsistent`);
      text(binding.entity, `activePlan.assignments.${taskId}.entity`); if (!ROLES.has(String(binding.role))) throw new Error(`activePlan.assignments.${taskId}.role is invalid`);
      optionalText(binding.parentTaskId, `activePlan.assignments.${taskId}.parentTaskId`);
      if (binding.allowDynamicChildren !== undefined && typeof binding.allowDynamicChildren !== "boolean") throw new Error(`activePlan.assignments.${taskId}.allowDynamicChildren must be boolean`);
      const scopes = stringArray(binding.scopeIds, `activePlan.assignments.${taskId}.scopeIds`); optionalText(binding.waveId, `activePlan.assignments.${taskId}.waveId`);
      if (binding.waveId !== undefined && waves[String(binding.waveId)] === undefined) throw new Error(`activePlan.assignments.${taskId} references an unknown wave`);
      if (!Array.isArray(binding.coverage)) throw new Error(`activePlan.assignments.${taskId}.coverage must be an array`);
      const cells = new Set<string>();
      for (const [index, rawCell] of binding.coverage.entries()) {
        const cell = object(rawCell, `activePlan.assignments.${taskId}.coverage[${index}]`); exactFields(cell, ["scopeId", "aspect"], `activePlan.assignments.${taskId}.coverage[${index}]`);
        const scopeId = text(cell.scopeId, `activePlan.assignments.${taskId}.coverage[${index}].scopeId`); const aspect = text(cell.aspect, `activePlan.assignments.${taskId}.coverage[${index}].aspect`);
        if (!scopes.includes(scopeId) || cells.has(`${scopeId}\u0000${aspect}`)) throw new Error(`activePlan.assignments.${taskId} has invalid coverage`);
        cells.add(`${scopeId}\u0000${aspect}`);
      }
      if (binding.delegatedCoverage !== undefined) {
        if (binding.role !== "coordinator" || binding.allowDynamicChildren !== true || !Array.isArray(binding.delegatedCoverage)) throw new Error(`activePlan.assignments.${taskId}.delegatedCoverage is invalid`);
        for (const [index, rawCell] of binding.delegatedCoverage.entries()) {
          const cell = object(rawCell, `activePlan.assignments.${taskId}.delegatedCoverage[${index}]`); exactFields(cell, ["scopeId", "aspect"], `activePlan.assignments.${taskId}.delegatedCoverage[${index}]`);
          const scopeId = text(cell.scopeId, `activePlan.assignments.${taskId}.delegatedCoverage[${index}].scopeId`); const aspect = text(cell.aspect, `activePlan.assignments.${taskId}.delegatedCoverage[${index}].aspect`);
          if (!scopes.includes(scopeId) || cells.has(`${scopeId}\u0000${aspect}`)) throw new Error(`activePlan.assignments.${taskId} has invalid delegated coverage`); cells.add(`${scopeId}\u0000${aspect}`);
        }
      }
      if ((binding.delegatedCoverage !== undefined) !== (binding.allowDynamicChildren === true)) throw new Error(`activePlan.assignments.${taskId} has inconsistent dynamic-child authority`);
    }
    for (const [taskId, rawBinding] of Object.entries(assignments)) {
      const binding = rawBinding as unknown as { parentTaskId?: string; role: string; waveId?: string; scopeIds: string[] };
      if (binding.parentTaskId === undefined) continue;
      const parent = assignments[binding.parentTaskId] as unknown as { role?: string; waveId?: string; scopeIds?: string[] } | undefined;
      if (parent?.role !== "coordinator" || binding.role === "coordinator" || binding.waveId !== parent.waveId || binding.scopeIds.some((scope) => !parent.scopeIds?.includes(scope))) throw new Error(`activePlan.assignments.${taskId} hierarchy is invalid`);
    }
  }
  const highestReviewRound = integer(record.highestReviewRound, "highestReviewRound");
  if (highestReviewRound > record.config.runCeilings.maxReviewRounds) throw new Error("highestReviewRound exceeds maxReviewRounds");
  const activePlan = record.activePlan;
  if (activePlan !== null && activePlan !== undefined && Math.max(...Object.values(activePlan.waves).map((wave) => wave.reviewRound)) > highestReviewRound) throw new Error("activePlan review rounds exceed highestReviewRound");
  const registeredWaves = object(record.registeredWaves, "registeredWaves");
  if (Object.keys(registeredWaves).length > record.config.runCeilings.maxWaves) throw new Error("registeredWaves exceeds maxWaves");
  for (const [waveId, rawWave] of Object.entries(registeredWaves)) {
    const wave = object(rawWave, `registeredWaves.${waveId}`); exactFields(wave, ["waveId", "planHash", "reviewRound", "registeredAt"], `registeredWaves.${waveId}`);
    if (wave.waveId !== waveId) throw new Error(`registeredWaves.${waveId} is inconsistent`); text(wave.planHash, `registeredWaves.${waveId}.planHash`); integer(wave.reviewRound, `registeredWaves.${waveId}.reviewRound`, 1); timestamp(wave.registeredAt, `registeredWaves.${waveId}.registeredAt`);
  }
  if (activePlan !== null && activePlan !== undefined && Object.entries(activePlan.waves).some(([waveId, wave]) => JSON.stringify(registeredWaves[waveId]) !== JSON.stringify(wave))) throw new Error("activePlan waves are not durably registered");
  if (record.status !== "active" && record.status !== "cancelled" && record.status !== "completed") throw new Error("Review agents state has an invalid status");
  timestamp(record.createdAt, "createdAt"); timestamp(record.updatedAt, "updatedAt");
  const lease = object(record.controllerLease, "controllerLease"); exactFields(lease, ["ownerId", "fencingToken", "expiresAt"], "controllerLease"); text(lease.ownerId, "controllerLease.ownerId"); text(lease.fencingToken, "controllerLease.fencingToken"); timestamp(lease.expiresAt, "controllerLease.expiresAt");
  for (const field of ["assignments", "idempotency", "results", "coverage", "waveLaunches", "registeredWaves"] as const) {
    if (record[field] === null || typeof record[field] !== "object" || Array.isArray(record[field])) throw new Error(`Review agents state has invalid ${field}`);
  }
  const state = value as ReviewAgentRunState;
  for (const name of ["usedLaunches", "outsideWaveLaunches", "usedActiveAgentTimeMs", "reservedAgentTimeMs"] as const) integer(raw[name], name);
  for (const [key, assignment] of Object.entries(state.assignments)) validateAssignment(key, assignment, state.config);
  for (const assignment of Object.values(state.assignments)) {
    if (assignment.parentDispatchId !== undefined) {
      const parent = state.assignments[assignment.parentDispatchId];
      if (parent === undefined || parent.role !== "coordinator" || assignment.role === "coordinator" || assignment.depth !== parent.depth + 1 || !parent.children.includes(assignment.dispatchId)) throw new Error(`assignments.${assignment.dispatchId} has an invalid parent relationship`);
    } else if (assignment.depth !== 1) throw new Error(`assignments.${assignment.dispatchId} root child must have depth 1`);
    for (const childId of assignment.children) {
      const child = state.assignments[childId];
      if (child === undefined || child.parentDispatchId !== assignment.dispatchId) throw new Error(`assignments.${assignment.dispatchId} has an invalid child ${childId}`);
    }
  }
  const idempotencyTargets = new Set<string>();
  for (const [key, dispatchId] of Object.entries(state.idempotency)) {
    text(key, "idempotency key"); text(dispatchId, `idempotency.${key}`);
    const assignment = state.assignments[dispatchId];
    if (assignment === undefined || assignment.idempotencyKey !== key || idempotencyTargets.has(dispatchId)) throw new Error(`idempotency.${key} is inconsistent`);
    idempotencyTargets.add(dispatchId);
  }
  if (idempotencyTargets.size !== Object.keys(state.assignments).length) throw new Error("Every assignment must have exactly one idempotency entry");
  for (const [key, result] of Object.entries(state.results)) validateResult(key, result, state);
  for (const assignment of Object.values(state.assignments)) if (assignment.resultId !== undefined && state.results[assignment.resultId] === undefined) throw new Error(`assignments.${assignment.dispatchId} references a missing result`);
  for (const [key, coverage] of Object.entries(state.coverage)) validateCoverage(key, coverage, state);
  let waveTotal = 0;
  for (const [wave, count] of Object.entries(state.waveLaunches)) { text(wave, "wave id"); waveTotal += integer(count, `waveLaunches.${wave}`); }
  const actualOutside = Object.values(state.assignments).filter((entry) => entry.waveId === undefined).length;
  const actualWaves = Object.values(state.assignments).filter((entry) => entry.waveId !== undefined).length;
  const reservationTotal = Object.values(state.assignments).reduce((sum, entry) => sum + entry.reservationMs, 0);
  const usedTotal = Object.values(state.assignments).reduce((sum, entry) => sum + entry.usedActiveMs, 0);
  if (state.usedLaunches !== Object.keys(state.assignments).length || state.outsideWaveLaunches !== actualOutside || waveTotal !== actualWaves) throw new Error("Review agents launch counters do not match assignments");
  if (state.reservedAgentTimeMs !== reservationTotal || state.usedActiveAgentTimeMs !== usedTotal) throw new Error("Review agents time counters do not match assignments");
  if (state.usedLaunches > state.config.runCeilings.maxLaunches || state.outsideWaveLaunches > state.config.runCeilings.maxLaunchesOutsideWaves) throw new Error("Review agents launch counters exceed configured ceilings");
  return state;
}

export async function readReviewAgentState(storageDir: string): Promise<ReviewAgentRunState> {
  let raw: string;
  try { raw = await readFile(statePath(storageDir), "utf8"); }
  catch (error) { if (isNotFound(error)) throw new Error(`Review agents state not found in ${storageDir}`, { cause: error }); throw error; }
  return validateReviewAgentState(JSON.parse(raw));
}

export async function createReviewAgentState(storageDir: string, state: ReviewAgentRunState): Promise<void> {
  await withFileLock(lockPath(storageDir), async () => {
    try { await readFile(statePath(storageDir), "utf8"); throw new Error(`Review agents state already exists in ${storageDir}`); }
    catch (error) { if (!isNotFound(error)) throw error; }
    await writeFileAtomic(statePath(storageDir), `${JSON.stringify(validateReviewAgentState(state), null, 2)}\n`, { mode: 0o600 });
  });
}

export async function acquireReviewAgentControllerLease(
  storageDir: string,
  ownerId: string,
  leaseMs: number,
  options: { now?: () => number; token?: () => string } = {},
): Promise<{ state: ReviewAgentRunState; fencingToken: string }> {
  text(ownerId, "ownerId"); integer(leaseMs, "leaseMs", 1);
  const now = options.now?.() ?? Date.now(); const token = options.token?.() ?? randomUUID();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("lease clock must return a non-negative safe integer");
  text(token, "fencingToken");
  return withFileLock(lockPath(storageDir), async () => {
    const state = await readReviewAgentState(storageDir); const currentExpiry = Date.parse(state.controllerLease.expiresAt);
    if (currentExpiry > now && state.controllerLease.ownerId !== ownerId) throw new Error(`Review agents run is owned by ${state.controllerLease.ownerId} until ${state.controllerLease.expiresAt}`);
    const expiresAtMs = now + leaseMs; if (!Number.isSafeInteger(expiresAtMs)) throw new Error("controller lease expiry exceeds the safe integer range");
    state.controllerLease = { ownerId, fencingToken: token, expiresAt: new Date(expiresAtMs).toISOString() };
    state.updatedAt = new Date(now).toISOString();
    await writeFileAtomic(statePath(storageDir), `${JSON.stringify(validateReviewAgentState(state), null, 2)}\n`, { mode: 0o600 });
    return { state, fencingToken: token };
  });
}

export async function renewReviewAgentControllerLease(storageDir: string, ownerId: string, fencingToken: string, leaseMs: number, now = Date.now()): Promise<ReviewAgentRunState> {
  integer(leaseMs, "leaseMs", 1);
  return withFileLock(lockPath(storageDir), async () => {
    const state = await readReviewAgentState(storageDir);
    if (state.controllerLease.ownerId !== ownerId || state.controllerLease.fencingToken !== fencingToken || Date.parse(state.controllerLease.expiresAt) <= now) throw new Error("Review agents controller lease is stale");
    const expiresAtMs = now + leaseMs; if (!Number.isSafeInteger(expiresAtMs)) throw new Error("controller lease expiry exceeds the safe integer range");
    state.controllerLease.expiresAt = new Date(expiresAtMs).toISOString(); state.updatedAt = new Date(now).toISOString();
    await writeFileAtomic(statePath(storageDir), `${JSON.stringify(validateReviewAgentState(state), null, 2)}\n`, { mode: 0o600 });
    return state;
  });
}

export async function mutateReviewAgentState<T>(storageDir: string, fencingToken: string, mutate: (state: ReviewAgentRunState) => T | Promise<T>, now = Date.now()): Promise<{ state: ReviewAgentRunState; value: T }> {
  text(fencingToken, "fencingToken");
  return withFileLock(lockPath(storageDir), async () => {
    const state = await readReviewAgentState(storageDir);
    if (state.controllerLease.fencingToken !== fencingToken || Date.parse(state.controllerLease.expiresAt) <= now) throw new Error("Review agents controller lease is stale");
    const value = await mutate(state);
    await writeFileAtomic(statePath(storageDir), `${JSON.stringify(validateReviewAgentState(state), null, 2)}\n`, { mode: 0o600 });
    return { state, value };
  });
}
