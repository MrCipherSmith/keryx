import { createHash } from "node:crypto";

/**
 * Review agents's pure planning contract.
 *
 * The plan records responsibility and intended coverage. It deliberately does
 * not infer coverage from an entity, skill, area owner, or scope: every
 * area/aspect cell must be claimed explicitly by an assignment and later
 * backed by the runtime's result evidence.
 */

export type ReviewAssignmentKind = "scout" | "coordinator" | "worker" | "validator";

export interface ReviewCoverageClaimInput {
  areaId: string;
  scopeId: string;
  aspect: string;
}

export interface ReviewAreaInput {
  id: string;
  title: string;
  requiredAspects: string[];
  ownerAssignmentId?: string;
}

export interface ReviewBoundaryInput {
  id: string;
  areaIds: string[];
  ownerAssignmentId?: string;
}

export interface ReviewAssignmentInput {
  id: string;
  agentInstanceId: string;
  kind: ReviewAssignmentKind;
  entity: string;
  parentAssignmentId?: string;
  areaIds: string[];
  scopeIds: string[];
  coverage: ReviewCoverageClaimInput[];
}

export interface ReviewPlanInput {
  revision: string;
  planVersion: number;
  areas: ReviewAreaInput[];
  boundaries: ReviewBoundaryInput[];
  assignments: ReviewAssignmentInput[];
}

export interface ReviewCoverageClaim {
  readonly areaId: string;
  readonly scopeId: string;
  readonly aspect: string;
}

export interface ReviewCoverageRequirement {
  readonly areaId: string;
  readonly aspect: string;
}

export interface ReviewArea {
  readonly id: string;
  readonly title: string;
  readonly requiredAspects: readonly string[];
  readonly ownerAssignmentId?: string;
}

export interface ReviewBoundary {
  readonly id: string;
  readonly areaIds: readonly string[];
  readonly ownerAssignmentId?: string;
}

export interface ReviewAssignment {
  readonly id: string;
  readonly agentInstanceId: string;
  readonly kind: ReviewAssignmentKind;
  readonly entity: string;
  readonly parentAssignmentId?: string;
  readonly areaIds: readonly string[];
  readonly scopeIds: readonly string[];
  readonly coverage: readonly ReviewCoverageClaim[];
}

export interface ReviewPlan {
  readonly revision: string;
  readonly planVersion: number;
  readonly areas: readonly ReviewArea[];
  readonly boundaries: readonly ReviewBoundary[];
  readonly assignments: readonly ReviewAssignment[];
}

export interface ReviewPlanEvaluation {
  readonly ready: boolean;
  readonly unownedAreaIds: readonly string[];
  readonly unownedBoundaryIds: readonly string[];
  readonly uncovered: readonly ReviewCoverageRequirement[];
}

export interface ReviewRuntimePlanWaveInput {
  readonly waveId: string;
  readonly reviewRound: number;
  /** Root assignments only; descendants inherit their coordinator's wave. */
  readonly assignmentIds: readonly string[];
}

export interface ReviewRuntimeCoverageCell {
  readonly scopeId: string;
  readonly aspect: string;
}

export interface ReviewRuntimePlanAssignment {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly entity: string;
  readonly role: ReviewAssignmentKind;
  readonly scopeIds: readonly string[];
  readonly waveId: string;
  readonly coverage: readonly ReviewRuntimeCoverageCell[];
  /** Envelope that dynamic leaf children may narrow, never coverage by the coordinator itself. */
  readonly delegatedCoverage?: readonly ReviewRuntimeCoverageCell[];
  readonly allowDynamicChildren?: boolean;
}

export interface ReviewRuntimePlanRegistration {
  readonly planHash: string;
  readonly planVersion: number;
  readonly revision: string;
  readonly waves: readonly { readonly waveId: string; readonly reviewRound: number }[];
  readonly assignments: readonly ReviewRuntimePlanAssignment[];
}

export class ReviewPlanError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid review plan:\n- ${issues.join("\n- ")}`);
    this.name = "ReviewPlanError";
    this.issues = Object.freeze([...issues]);
  }
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function clonePlan(input: ReviewPlanInput): ReviewPlan {
  return {
    revision: input.revision,
    planVersion: input.planVersion,
    areas: input.areas.map((area) => ({
      id: area.id,
      title: area.title,
      requiredAspects: [...area.requiredAspects],
      ...(area.ownerAssignmentId === undefined ? {} : { ownerAssignmentId: area.ownerAssignmentId }),
    })),
    boundaries: input.boundaries.map((boundary) => ({
      id: boundary.id,
      areaIds: [...boundary.areaIds],
      ...(boundary.ownerAssignmentId === undefined ? {} : { ownerAssignmentId: boundary.ownerAssignmentId }),
    })),
    assignments: input.assignments.map((assignment) => ({
      id: assignment.id,
      agentInstanceId: assignment.agentInstanceId,
      kind: assignment.kind,
      entity: assignment.entity,
      ...(assignment.parentAssignmentId === undefined ? {} : { parentAssignmentId: assignment.parentAssignmentId }),
      areaIds: [...assignment.areaIds],
      scopeIds: [...assignment.scopeIds],
      coverage: assignment.coverage.map((claim) => ({ ...claim })),
    })),
  };
}

/** Build and validate an immutable snapshot of one review revision. */
export function createReviewPlan(input: ReviewPlanInput): ReviewPlan {
  const issues: string[] = [];
  if (!nonEmpty(input.revision)) issues.push("revision must be non-empty");
  if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 1) {
    issues.push("planVersion must be a positive safe integer");
  }

  for (const duplicate of duplicates(input.areas.map(({ id }) => id))) issues.push(`duplicate area id ${duplicate}`);
  for (const duplicate of duplicates(input.boundaries.map(({ id }) => id))) issues.push(`duplicate boundary id ${duplicate}`);
  for (const duplicate of duplicates(input.assignments.map(({ id }) => id))) issues.push(`duplicate assignment id ${duplicate}`);

  const areas = new Map(input.areas.map((area) => [area.id, area]));
  const assignments = new Map(input.assignments.map((assignment) => [assignment.id, assignment]));

  for (const area of input.areas) {
    if (!nonEmpty(area.id)) issues.push("area id must be non-empty");
    if (!nonEmpty(area.title)) issues.push(`area ${area.id || "<empty>"} title must be non-empty`);
    if (area.requiredAspects.length === 0) issues.push(`area ${area.id} needs at least one required aspect`);
    for (const duplicate of duplicates(area.requiredAspects)) issues.push(`area ${area.id} repeats aspect ${duplicate}`);
    if (area.requiredAspects.some((aspect) => !nonEmpty(aspect))) issues.push(`area ${area.id} has an empty aspect`);
    if (area.ownerAssignmentId !== undefined && !assignments.has(area.ownerAssignmentId)) {
      issues.push(`area ${area.id} owner ${area.ownerAssignmentId} does not exist`);
    }
  }

  for (const boundary of input.boundaries) {
    if (!nonEmpty(boundary.id)) issues.push("boundary id must be non-empty");
    if (new Set(boundary.areaIds).size < 2) issues.push(`boundary ${boundary.id} must connect at least two distinct areas`);
    for (const areaId of boundary.areaIds) {
      if (!areas.has(areaId)) issues.push(`boundary ${boundary.id} references unknown area ${areaId}`);
    }
    if (boundary.ownerAssignmentId !== undefined && !assignments.has(boundary.ownerAssignmentId)) {
      issues.push(`boundary ${boundary.id} owner ${boundary.ownerAssignmentId} does not exist`);
    }
  }

  for (const assignment of input.assignments) {
    if (!nonEmpty(assignment.id)) issues.push("assignment id must be non-empty");
    if (!nonEmpty(assignment.agentInstanceId)) issues.push(`assignment ${assignment.id} agentInstanceId must be non-empty`);
    if (!nonEmpty(assignment.entity)) issues.push(`assignment ${assignment.id} entity must be non-empty`);
    for (const duplicate of duplicates(assignment.areaIds)) issues.push(`assignment ${assignment.id} repeats area ${duplicate}`);
    for (const duplicate of duplicates(assignment.scopeIds)) issues.push(`assignment ${assignment.id} repeats scope ${duplicate}`);
    if (assignment.scopeIds.some((scopeId) => !nonEmpty(scopeId))) issues.push(`assignment ${assignment.id} has an empty scope`);
    if (assignment.kind !== "validator" && assignment.scopeIds.length === 0) issues.push(`assignment ${assignment.id} requires at least one scope`);
    for (const areaId of assignment.areaIds) {
      if (!areas.has(areaId)) issues.push(`assignment ${assignment.id} references unknown area ${areaId}`);
    }

    if (assignment.parentAssignmentId !== undefined) {
      const parent = assignments.get(assignment.parentAssignmentId);
      if (assignment.kind !== "worker") {
        issues.push(`assignment ${assignment.id} kind ${assignment.kind} cannot have a parent`);
      } else if (parent === undefined) {
        issues.push(`assignment ${assignment.id} parent ${assignment.parentAssignmentId} does not exist`);
      } else if (parent.kind !== "coordinator") {
        issues.push(`assignment ${assignment.id} parent ${parent.id} is not a coordinator`);
      }
    }

    const claims = assignment.coverage.map(({ areaId, scopeId, aspect }) => `${areaId}\u0000${scopeId}\u0000${aspect}`);
    for (const duplicate of duplicates(claims)) {
      const [areaId, scopeId, aspect] = duplicate.split("\u0000");
      issues.push(`assignment ${assignment.id} repeats coverage ${areaId}/${scopeId}/${aspect}`);
    }
    if (assignment.coverage.length > 0 && assignment.kind !== "worker") {
      issues.push(`assignment ${assignment.id} kind ${assignment.kind} cannot claim leaf coverage`);
    }
    for (const claim of assignment.coverage) {
      const area = areas.get(claim.areaId);
      if (area === undefined) {
        issues.push(`assignment ${assignment.id} coverage references unknown area ${claim.areaId}`);
        continue;
      }
      if (!assignment.areaIds.includes(claim.areaId)) {
        issues.push(`assignment ${assignment.id} claims area ${claim.areaId} outside its responsibility`);
      }
      if (!nonEmpty(claim.scopeId) || !assignment.scopeIds.includes(claim.scopeId)) {
        issues.push(`assignment ${assignment.id} claims scope ${claim.scopeId || "<empty>"} outside its responsibility`);
      }
      if (!area.requiredAspects.includes(claim.aspect)) {
        issues.push(`assignment ${assignment.id} coverage uses unknown aspect ${claim.aspect} for area ${claim.areaId}`);
      }
    }

    if (assignment.parentAssignmentId !== undefined) {
      const parent = assignments.get(assignment.parentAssignmentId);
      if (parent !== undefined) {
        for (const areaId of assignment.areaIds) {
          if (!parent.areaIds.includes(areaId)) issues.push(`assignment ${assignment.id} area ${areaId} expands parent ${parent.id}`);
        }
        for (const scopeId of assignment.scopeIds) {
          if (!parent.scopeIds.includes(scopeId)) issues.push(`assignment ${assignment.id} scope ${scopeId} expands parent ${parent.id}`);
        }
      }
    }
  }

  for (const area of input.areas) {
    const owner = area.ownerAssignmentId === undefined ? undefined : assignments.get(area.ownerAssignmentId);
    if (owner !== undefined && !owner.areaIds.includes(area.id)) issues.push(`area ${area.id} owner ${owner.id} does not own the area`);
  }
  for (const boundary of input.boundaries) {
    const owner = boundary.ownerAssignmentId === undefined ? undefined : assignments.get(boundary.ownerAssignmentId);
    if (owner !== undefined) {
      for (const areaId of boundary.areaIds) {
        if (!owner.areaIds.includes(areaId)) issues.push(`boundary ${boundary.id} owner ${owner.id} does not span area ${areaId}`);
      }
    }
  }

  if (issues.length > 0) throw new ReviewPlanError(issues);
  return freezeDeep(clonePlan(input));
}

/** Report responsibility and planned-coverage gaps without inventing evidence. */
export function evaluateReviewPlan(plan: ReviewPlan): ReviewPlanEvaluation {
  const covered = new Set(
    plan.assignments.flatMap((assignment) => assignment.coverage.map(({ areaId, aspect }) => `${areaId}\u0000${aspect}`)),
  );
  const uncovered = plan.areas.flatMap((area) =>
    area.requiredAspects
      .filter((aspect) => !covered.has(`${area.id}\u0000${aspect}`))
      .map((aspect) => ({ areaId: area.id, aspect })),
  );
  const unownedAreaIds = plan.areas.filter(({ ownerAssignmentId }) => ownerAssignmentId === undefined).map(({ id }) => id);
  const unownedBoundaryIds = plan.boundaries
    .filter(({ ownerAssignmentId }) => ownerAssignmentId === undefined)
    .map(({ id }) => id);
  return freezeDeep({
    ready: uncovered.length === 0 && unownedAreaIds.length === 0 && unownedBoundaryIds.length === 0,
    unownedAreaIds,
    unownedBoundaryIds,
    uncovered,
  });
}

/**
 * Convert a complete host-approved plan into an immutable controller snapshot.
 * Coordinator cells are a delegation envelope only; runtime coverage still
 * requires a completed leaf result at the same plan hash/version/revision.
 */
export function createReviewRuntimePlanRegistration(
  plan: ReviewPlan,
  waves: readonly ReviewRuntimePlanWaveInput[],
): ReviewRuntimePlanRegistration {
  const issues: string[] = [];
  const evaluation = evaluateReviewPlan(plan);
  for (const areaId of evaluation.unownedAreaIds) issues.push(`area ${areaId} has no owner`);
  for (const boundaryId of evaluation.unownedBoundaryIds) issues.push(`boundary ${boundaryId} has no owner`);
  for (const { areaId, aspect } of evaluation.uncovered) issues.push(`area ${areaId} aspect ${aspect} has no leaf assignment`);

  const assignments = new Map(plan.assignments.map((assignment) => [assignment.id, assignment]));
  const rootIds = new Set(plan.assignments.filter(({ parentAssignmentId }) => parentAssignmentId === undefined).map(({ id }) => id));
  const waveByRoot = new Map<string, string>();
  const waveIds = new Set<string>();
  const normalizedWaves = waves.map((wave) => {
    if (!nonEmpty(wave.waveId)) issues.push("wave id must be non-empty");
    if (waveIds.has(wave.waveId)) issues.push(`duplicate wave id ${wave.waveId}`);
    waveIds.add(wave.waveId);
    if (!Number.isSafeInteger(wave.reviewRound) || wave.reviewRound < 1) issues.push(`wave ${wave.waveId} reviewRound must be a positive safe integer`);
    for (const duplicate of duplicates(wave.assignmentIds)) issues.push(`wave ${wave.waveId} repeats assignment ${duplicate}`);
    for (const assignmentId of wave.assignmentIds) {
      if (!rootIds.has(assignmentId)) issues.push(`wave ${wave.waveId} assignment ${assignmentId} is not a root assignment`);
      if (waveByRoot.has(assignmentId)) issues.push(`assignment ${assignmentId} belongs to multiple waves`);
      waveByRoot.set(assignmentId, wave.waveId);
    }
    return { waveId: wave.waveId, reviewRound: wave.reviewRound, assignmentIds: [...wave.assignmentIds] };
  });
  for (const rootId of rootIds) if (!waveByRoot.has(rootId)) issues.push(`root assignment ${rootId} has no wave`);

  const rootFor = (assignment: ReviewAssignment): ReviewAssignment | undefined => {
    let current = assignment;
    const seen = new Set<string>();
    while (current.parentAssignmentId !== undefined) {
      if (seen.has(current.id)) return undefined;
      seen.add(current.id);
      const parent = assignments.get(current.parentAssignmentId);
      if (parent === undefined) return undefined;
      current = parent;
    }
    return current;
  };
  const cells = (assignment: ReviewAssignment): ReviewRuntimeCoverageCell[] =>
    assignment.coverage.map(({ scopeId, aspect }) => ({ scopeId, aspect }));
  const descendants = (parentId: string): ReviewAssignment[] => plan.assignments.filter((candidate) => {
    let parent = candidate.parentAssignmentId;
    while (parent !== undefined) {
      if (parent === parentId) return true;
      parent = assignments.get(parent)?.parentAssignmentId;
    }
    return false;
  });
  const uniqueCells = (values: readonly ReviewRuntimeCoverageCell[]): ReviewRuntimeCoverageCell[] => {
    const seen = new Set<string>();
    return values.filter(({ scopeId, aspect }) => {
      const key = `${scopeId}\u0000${aspect}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const runtimeAssignments: ReviewRuntimePlanAssignment[] = plan.assignments.flatMap((assignment) => {
    const root = rootFor(assignment);
    const waveId = root === undefined ? undefined : waveByRoot.get(root.id);
    if (waveId === undefined) return [];
    const delegatedCoverage = assignment.kind === "coordinator"
      ? uniqueCells(descendants(assignment.id).flatMap(cells))
      : undefined;
    return [{
      taskId: assignment.id,
      ...(assignment.parentAssignmentId === undefined ? {} : { parentTaskId: assignment.parentAssignmentId }),
      entity: assignment.entity,
      role: assignment.kind,
      scopeIds: [...assignment.scopeIds],
      waveId,
      coverage: cells(assignment),
      ...(delegatedCoverage === undefined ? {} : { delegatedCoverage }),
      ...(assignment.kind === "coordinator" ? { allowDynamicChildren: true } : {}),
    }];
  });

  if (issues.length > 0) throw new ReviewPlanError(issues);
  const planHash = createHash("sha256")
    .update(JSON.stringify({ plan, waves: normalizedWaves }))
    .digest("hex");
  return freezeDeep({
    planHash,
    planVersion: plan.planVersion,
    revision: plan.revision,
    waves: normalizedWaves.map(({ waveId, reviewRound }) => ({ waveId, reviewRound })),
    assignments: runtimeAssignments,
  });
}

export type RevisionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "stale_revision";
      readonly plannedRevision: string;
      readonly actualRevision: string;
    };

/** A plan is valid only for the exact revision captured during preparation. */
export function assertPlanRevision(plan: ReviewPlan, actualRevision: string): RevisionCheck {
  return plan.revision === actualRevision
    ? { ok: true }
    : {
        ok: false,
        reason: "stale_revision",
        plannedRevision: plan.revision,
        actualRevision,
      };
}

export type FindingValidationCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "assignment_not_found"
        | "same_assignment"
        | "assignment_is_not_validator"
        | "same_agent_instance";
    };

/** Prevent a finding author (including the same runtime instance under another task id) from validating itself. */
export function canValidateFinding(
  plan: ReviewPlan,
  validatorAssignmentId: string,
  sourceAssignmentId: string,
): FindingValidationCheck {
  if (validatorAssignmentId === sourceAssignmentId) return { ok: false, reason: "same_assignment" };
  const validator = plan.assignments.find(({ id }) => id === validatorAssignmentId);
  const source = plan.assignments.find(({ id }) => id === sourceAssignmentId);
  if (validator === undefined || source === undefined) return { ok: false, reason: "assignment_not_found" };
  if (validator.kind !== "validator") return { ok: false, reason: "assignment_is_not_validator" };
  if (validator.agentInstanceId === source.agentInstanceId) return { ok: false, reason: "same_agent_instance" };
  return { ok: true };
}
