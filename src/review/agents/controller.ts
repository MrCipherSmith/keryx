import { randomUUID } from "node:crypto";
import { reviewAgentResultStatus } from "./result-validation";
import { createLargeReviewConfig, validateReviewAgentConfig } from "./config";
import { createReviewAgentDeadline, reviewAgentsAbortableDelay, startReviewAgentLeaseHeartbeat, type ReviewAgentDeadline, type ReviewAgentLeaseHeartbeat } from "./lifecycle";
import { acquireReviewAgentControllerLease, createReviewAgentState, mutateReviewAgentState, readReviewAgentState } from "./store";
import type {
  ReviewAgentAdapter, ReviewAgentAdapterCapabilities, ReviewAgentAdapterContext, ReviewAgentAdapterRequest,
  ReviewAgentAdmission, ReviewAgentAssignmentRecord, ReviewAgentAssignmentStatus,
  ReviewAgentControllerDependencies, ReviewAgentCoverageRecord, ReviewAgentCreateOptions, ReviewAgentEntityPolicy,
  ReviewAgentHostSpawnOptions, ReviewAgentOpenOptions, ReviewAgentRegisterPlanInput, ReviewAgentRunState, ReviewAgentScopedController, ReviewAgentSpawnInput, ReviewAgentStoredResult, ReviewAgentTerminalResult,
} from "./types";

const TERMINAL = new Set<ReviewAgentAssignmentStatus>(["completed", "blocked", "failed", "cancelled", "unresolved"]);
function clone<T>(value: T): T { return structuredClone(value); }
function terminal(record: ReviewAgentAssignmentRecord): boolean { return TERMINAL.has(record.status); }
/** Still consumes a local/run incompleteness slot, including unconfirmed external processes. */
function occupiesCapacity(record: ReviewAgentAssignmentRecord): boolean { return record.status !== "completed" && record.status !== "blocked" && record.status !== "failed" && record.status !== "cancelled"; }
function nowIso(clock: () => Date): string { return clock().toISOString(); }
function terminalResult(record: ReviewAgentAssignmentRecord): ReviewAgentTerminalResult {
  if (!terminal(record)) throw new Error(`Assignment ${record.dispatchId} is not terminal`);
  return {
    dispatchId: record.dispatchId,
    status: record.status as ReviewAgentTerminalResult["status"],
    ...(record.resultId === undefined ? {} : { resultId: record.resultId }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}
function refusal(code: Extract<ReviewAgentAdmission, { ok: false }>["code"], message: string): ReviewAgentAdmission { return { ok: false, code, message }; }
function sameStrings(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function redactAssignment(record: ReviewAgentAssignmentRecord): ReviewAgentAssignmentRecord {
  const { authorityRef: _authorityRef, ...redacted } = clone(record);
  return redacted;
}
function redactRunState(state: ReviewAgentRunState): ReviewAgentRunState {
  const redacted = clone(state);
  redacted.controllerLease.fencingToken = "[redacted]";
  for (const [dispatchId, record] of Object.entries(redacted.assignments)) redacted.assignments[dispatchId] = redactAssignment(record);
  for (const resultId of Object.keys(redacted.results)) delete redacted.results[resultId];
  return redacted;
}
function authorityAllowed(value: Awaited<ReturnType<ReviewAgentControllerDependencies["authority"]["authorize"]>>): boolean { return typeof value === "boolean" ? value : value.allowed; }
function grantedAuthorityRef(value: Awaited<ReturnType<ReviewAgentControllerDependencies["authority"]["authorize"]>>): string | undefined { return typeof value === "object" && value.allowed ? value.authorityRef : undefined; }

interface Deferred<T> { readonly promise: Promise<T>; readonly resolve: (value: T) => void }
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; const promise = new Promise<T>((settle) => { resolve = settle; }); return { promise, resolve }; }

export class ReviewAgentController {
  readonly storageDir: string;
  private state: ReviewAgentRunState;
  private readonly adapters: ReadonlyMap<string, ReviewAgentAdapter>;
  private readonly authority: ReviewAgentControllerDependencies["authority"];
  private readonly entityPolicies: ReviewAgentControllerDependencies["entityPolicies"];
  private readonly clock: () => Date;
  private readonly id: () => string;
  private readonly ownerId: string | undefined;
  private readonly leaseMs: number;
  private readonly cancelCleanupTimeoutMs: number;
  private readonly reconcileTimeoutMs: number;
  private fencingToken: string | undefined;
  private readonly aborts = new Map<string, AbortController>();
  private readonly runningExecutions = new Set<string>();
  private readonly resumeWaiters = new Map<string, Deferred<boolean>>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly deadlines = new Map<string, ReviewAgentDeadline>();
  private heartbeat: ReviewAgentLeaseHeartbeat | undefined;
  private leaseFailure: unknown;
  private closed = false;
  private pumping = false;

  private constructor(options: ReviewAgentControllerDependencies, state: ReviewAgentRunState) {
    this.storageDir = options.storageDir;
    this.state = state;
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
    this.authority = options.authority;
    this.entityPolicies = options.entityPolicies;
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? (() => randomUUID());
    this.ownerId = options.ownerId;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.cancelCleanupTimeoutMs = options.cancelCleanupTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.cancelCleanupTimeoutMs) || this.cancelCleanupTimeoutMs < 1) throw new Error("cancelCleanupTimeoutMs must be a positive safe integer");
    this.reconcileTimeoutMs = options.reconcileTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.reconcileTimeoutMs) || this.reconcileTimeoutMs < 1) throw new Error("reconcileTimeoutMs must be a positive safe integer");
    this.fencingToken = options.ownerId === state.controllerLease.ownerId ? state.controllerLease.fencingToken : undefined;
    if (this.ownerId !== undefined && this.fencingToken !== undefined) {
      this.heartbeat = startReviewAgentLeaseHeartbeat({
        storageDir: this.storageDir, ownerId: this.ownerId, fencingToken: this.fencingToken,
        leaseMs: this.leaseMs, now: () => this.clock().getTime(),
        onFailure: (error) => {
          this.leaseFailure = error;
          for (const abort of this.aborts.values()) abort.abort(error);
        },
      });
    }
  }

  static async create(options: ReviewAgentCreateOptions): Promise<ReviewAgentController> {
    validateReviewAgentConfig(options.config);
    if (options.config.costMode === "measured-cost") throw new Error("measured-cost is fail-closed until an adapter-backed pre-spend admission ledger is configured");
    if (!options.ownerId.trim()) throw new Error("A mutable Review agents controller requires ownerId");
    const clock = options.clock ?? (() => new Date());
    const createdAt = nowIso(clock);
    const fencingToken = (options.id ?? (() => randomUUID()))();
    const leaseMs = options.leaseMs ?? 60_000;
    const state: ReviewAgentRunState = {
      schemaVersion: 1, runId: options.runId, revision: options.revision, config: clone(options.config), status: "active",
      createdAt, updatedAt: createdAt, controllerLease: { ownerId: options.ownerId, fencingToken, expiresAt: new Date(clock().getTime() + leaseMs).toISOString() }, usedLaunches: 0, outsideWaveLaunches: 0, usedActiveAgentTimeMs: 0,
      reservedAgentTimeMs: 0, waveLaunches: {}, registeredWaves: {}, activePlan: null, highestReviewRound: 0, assignments: {}, idempotency: {}, results: {}, coverage: {},
    };
    await createReviewAgentState(options.storageDir, state);
    return new ReviewAgentController(options, state);
  }

  static async open(options: ReviewAgentOpenOptions): Promise<ReviewAgentController> {
    if (options.ownerId === undefined) return new ReviewAgentController(options, await readReviewAgentState(options.storageDir));
    const acquired = await acquireReviewAgentControllerLease(options.storageDir, options.ownerId, options.leaseMs ?? 60_000, { now: () => (options.clock ?? (() => new Date()))().getTime(), ...(options.id === undefined ? {} : { token: options.id }) });
    const controller = new ReviewAgentController(options, acquired.state);
    await controller.reconcile();
    return controller;
  }

  capabilities(adapterId?: string): ReviewAgentAdapterCapabilities | Readonly<Record<string, ReviewAgentAdapterCapabilities>> | undefined {
    if (adapterId !== undefined) return this.adapters.get(adapterId)?.capabilities;
    return Object.fromEntries([...this.adapters].map(([id, adapter]) => [id, clone(adapter.capabilities)]));
  }

  async status(dispatchId?: string): Promise<ReviewAgentRunState | ReviewAgentAssignmentRecord | undefined> {
    this.state = await readReviewAgentState(this.storageDir);
    const assignment = dispatchId === undefined ? undefined : this.state.assignments[dispatchId];
    return dispatchId === undefined ? redactRunState(this.state) : assignment === undefined ? undefined : redactAssignment(assignment);
  }

  async spawn(input: ReviewAgentSpawnInput, hostOptions: ReviewAgentHostSpawnOptions = {}): Promise<ReviewAgentAdmission> {
    return this.spawnInternal(input, undefined, hostOptions);
  }

  async registerPlan(input: ReviewAgentRegisterPlanInput): Promise<void> {
    this.state = await readReviewAgentState(this.storageDir);
    if (!authorityAllowed(await this.authority.authorize({ operation: "register_plan", runId: this.state.runId, planHash: input.planHash, planVersion: input.planVersion }))) throw new Error("The effective host authority denied plan registration");
    await this.modify((state) => {
      if (!/^[a-f0-9]{64}$/.test(input.planHash) || input.revision !== state.revision || !Number.isSafeInteger(input.planVersion) || input.planVersion < 1) throw new Error("Plan registration must have the run revision, a SHA-256 plan hash, and a positive version");
      if (input.waves.length === 0 || input.waves.length > state.config.runCeilings.maxWaves || input.assignments.length === 0) throw new Error("Plan registration must contain bounded waves and assignments");
      const registeredAt = nowIso(this.clock); const waves: Record<string, { waveId: string; planHash: string; reviewRound: number; registeredAt: string }> = {};
      for (const wave of input.waves) {
        if (!wave.waveId.trim() || waves[wave.waveId] !== undefined || !Number.isSafeInteger(wave.reviewRound) || wave.reviewRound < 1 || wave.reviewRound > state.config.runCeilings.maxReviewRounds) throw new Error("Plan registration has an invalid or duplicate wave");
        waves[wave.waveId] = { waveId: wave.waveId, planHash: input.planHash, reviewRound: wave.reviewRound, registeredAt };
      }
      const assignments: Record<string, ReviewAgentRegisterPlanInput["assignments"][number]> = {};
      for (const binding of input.assignments) {
        if (!binding.taskId.trim() || !binding.entity.trim() || !["coordinator", "worker", "scout", "validator"].includes(binding.role) || assignments[binding.taskId] !== undefined || new Set(binding.scopeIds).size !== binding.scopeIds.length || binding.scopeIds.some((scope) => !scope.trim()) || (binding.waveId !== undefined && waves[binding.waveId] === undefined)) throw new Error("Plan registration has an invalid assignment binding");
        const cells = new Set<string>();
        for (const cell of [...binding.coverage, ...(binding.delegatedCoverage ?? [])]) {
          const key = `${cell.scopeId}\u0000${cell.aspect}`;
          if (!binding.scopeIds.includes(cell.scopeId) || !cell.aspect.trim() || cells.has(key)) throw new Error("Plan registration has invalid assignment coverage");
          cells.add(key);
        }
        if (binding.allowDynamicChildren === true && binding.role !== "coordinator") throw new Error("Only a coordinator may allow dynamic children");
        if ((binding.delegatedCoverage !== undefined) !== (binding.allowDynamicChildren === true)) throw new Error("Dynamic-child authority and delegated coverage must be registered together");
        assignments[binding.taskId] = clone(binding);
      }
      for (const binding of Object.values(assignments)) {
        if (binding.parentTaskId === undefined) { if (binding.waveId === undefined) throw new Error("Root plan assignment must belong to a wave"); continue; }
        const parent = assignments[binding.parentTaskId];
        if (parent === undefined || parent.role !== "coordinator" || binding.role === "coordinator" || binding.waveId !== parent.waveId || binding.scopeIds.some((scope) => !parent.scopeIds.includes(scope))) throw new Error("Plan assignment hierarchy is invalid");
      }
      const normalized = { planHash: input.planHash, planVersion: input.planVersion, revision: input.revision, registeredAt, waves, assignments };
      if (state.activePlan?.planHash === input.planHash && state.activePlan.planVersion === input.planVersion) {
        const existing = clone(state.activePlan); (existing as { registeredAt: string }).registeredAt = registeredAt; for (const wave of Object.values(existing.waves)) (wave as { registeredAt: string }).registeredAt = registeredAt;
        if (JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error("Plan hash/version is already registered with different content");
        return;
      }
      if (Object.keys(state.registeredWaves).length + Object.keys(waves).length > state.config.runCeilings.maxWaves || Object.keys(waves).some((waveId) => state.registeredWaves[waveId] !== undefined)) throw new Error("Plan registration exceeds the run-scoped registered wave cap or reuses a wave id");
      if (state.activePlan !== null && Object.values(state.assignments).some((record) => record.planHash === state.activePlan?.planHash && occupiesCapacity(record))) throw new Error("Cannot supersede a plan while its assignments are incomplete");
      const highestRound = Math.max(...input.waves.map((wave) => wave.reviewRound));
      if (state.activePlan !== null && input.planVersion <= state.activePlan.planVersion) throw new Error("Plan versions must increase monotonically");
      if (Math.min(...input.waves.map((wave) => wave.reviewRound)) <= state.highestReviewRound) throw new Error("Review rounds must increase monotonically across plans");
      state.highestReviewRound = highestRound;
      for (const [waveId, wave] of Object.entries(waves)) state.registeredWaves[waveId] = wave;
      for (const key of Object.keys(state.coverage)) delete state.coverage[key];
      state.activePlan = normalized;
    });
  }

  /** Bounded shutdown. In-flight work is durably unresolved until a later owner reconciles it. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.state = await readReviewAgentState(this.storageDir);
    const active = Object.values(this.state.assignments).filter((record) => !terminal(record) && record.status !== "queued").map((record) => record.dispatchId);
    if (active.length > 0 && this.fencingToken !== undefined && this.leaseFailure === undefined) {
      await this.modify((state) => {
        for (const dispatchId of active) {
          const record = state.assignments[dispatchId];
          if (record === undefined || terminal(record)) continue;
          this.finishActiveSegment(state, record);
          record.status = "unresolved"; record.error = "controller_closed_before_process_exit"; record.updatedAt = nowIso(this.clock);
        }
      });
    }
    for (const abort of this.aborts.values()) abort.abort(new Error("Review agents controller closed"));
    for (const deadline of this.deadlines.values()) deadline.stop();
    this.deadlines.clear();
    this.closed = true;
    this.heartbeat?.stop();
    this.heartbeat = undefined;
  }

  scoped(parentDispatchId: string): ReviewAgentScopedController {
    const assertScope = async (dispatchId: string): Promise<void> => {
      this.state = await readReviewAgentState(this.storageDir);
      let current = this.state.assignments[dispatchId];
      while (current !== undefined && current.dispatchId !== parentDispatchId) current = current.parentDispatchId === undefined ? undefined : this.state.assignments[current.parentDispatchId];
      if (current?.dispatchId !== parentDispatchId || dispatchId === parentDispatchId) throw new Error(`Assignment ${dispatchId} is outside coordinator ${parentDispatchId}'s subtree`);
    };
    return {
      spawn: (input) => this.spawnInternal(input, parentDispatchId),
      status: async (dispatchId) => { await assertScope(dispatchId); const value = await this.status(dispatchId); return value !== undefined && "dispatchId" in value ? value : undefined; },
      wait: async (dispatchId, options) => { await assertScope(dispatchId); return this.wait(dispatchId, options); },
      result: async (dispatchId) => { await assertScope(dispatchId); return this.result(dispatchId); },
      cancel: async (dispatchId, reason) => { await assertScope(dispatchId); return this.cancel(dispatchId, reason); },
      waitChildren: async (dispatchIds) => { for (const id of dispatchIds) await assertScope(id); return this.waitChildrenFrom(parentDispatchId, dispatchIds); },
    };
  }

  private async policy(entity: string): Promise<ReviewAgentEntityPolicy | undefined> {
    return this.entityPolicies?.resolve(entity);
  }

  private async spawnInternal(input: ReviewAgentSpawnInput, parentDispatchId?: string, hostOptions: ReviewAgentHostSpawnOptions = {}): Promise<ReviewAgentAdmission> {
    if (this.fencingToken === undefined) return refusal("run_closed", "This controller is read-only; open it with ownerId to mutate the run");
    this.state = await readReviewAgentState(this.storageDir);
    const parentAuthorityRef = parentDispatchId === undefined ? undefined : this.state.assignments[parentDispatchId]?.authorityRef;
    const candidateDispatchId = this.id();
    const decision = await this.authority.authorize({ operation: "spawn", runId: this.state.runId, dispatchId: candidateDispatchId, ...(parentDispatchId === undefined ? {} : { parentDispatchId }), entity: input.entity, adapterId: input.adapterId, ...(parentAuthorityRef === undefined ? {} : { authorityRef: parentAuthorityRef }) });
    if (!authorityAllowed(decision)) return refusal("authority_denied", "The effective host authority denied spawn");
    const authorityRef = grantedAuthorityRef(decision) ?? parentAuthorityRef;
    if (!input.taskId.trim() || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || !input.entity.trim() || !input.adapterId.trim()) return refusal("invalid_input", "taskId, entity, adapterId and a positive attempt are required");
    const adapter = this.adapters.get(input.adapterId);
    if (adapter === undefined) return refusal("adapter_missing", `Adapter ${input.adapterId} is unavailable`);
    if (!adapter.capabilities.readOnlyEnforced || !adapter.capabilities.resultPersistence || !adapter.capabilities.cancellation || (input.role === "coordinator" && !adapter.capabilities.hierarchy)) return refusal("adapter_unsupported", `Adapter ${input.adapterId} cannot enforce the required review capabilities`);
    if (this.state.config.costMode === "measured-cost") return refusal("adapter_unsupported", "measured-cost admission is unavailable without a durable pre-spend adapter ledger");
    const policy = await this.policy(input.entity);
    if (policy === undefined || policy.role !== input.role) return refusal("role_violation", `Entity ${input.entity} is not bound to role ${input.role}`);

    const admission = await this.modify(async (state) => {
      if (state.status !== "active") return refusal("run_closed", `Run is ${state.status}`);
      const elapsed = this.clock().getTime() - new Date(state.createdAt).getTime();
      if (elapsed >= state.config.runCeilings.elapsedDeadlineMs) return refusal("time_limit", "Run elapsed deadline reached");
      if (!(state.config.allowedAdapters ?? []).includes(input.adapterId)) return refusal("adapter_unsupported", `Adapter ${input.adapterId} is not allowed by the run snapshot`);
      if (!(state.config.allowedEntities ?? []).includes(input.entity)) return refusal("entity_denied", `Entity ${input.entity} is not allowed by the run snapshot`);
      if (input.skillRef !== undefined && (!(state.config.allowedSkills ?? []).includes(input.skillRef) || !policy.allowedSkills.includes(input.skillRef))) return refusal("skill_denied", `Skill ${input.skillRef} is not allowed for ${input.entity}`);
      const requestedScopes = input.scopeIds ?? [];
      if (requestedScopes.some((scope) => !scope.trim()) || new Set(requestedScopes).size !== requestedScopes.length) return refusal("invalid_input", "scopeIds must be unique non-empty strings");
      const parent = parentDispatchId === undefined ? undefined : state.assignments[parentDispatchId];
      if (parentDispatchId !== undefined && parent === undefined) return refusal("invalid_input", `Parent ${parentDispatchId} does not exist`);
      if (parent !== undefined && terminal(parent)) return refusal("role_violation", `Parent ${parentDispatchId} is already ${parent.status}`);
      if (parent !== undefined && (requestedScopes.length === 0 || requestedScopes.some((scope) => !parent.scopeIds.includes(scope)))) return refusal("invalid_input", "Child scope must be a non-empty subset of its parent scope");
      const plan = state.activePlan; const binding = plan?.assignments[input.taskId];
      let effectiveWaveId: string | undefined; let coverageCells: readonly { readonly scopeId: string; readonly aspect: string }[] | undefined;
      if (plan === null) {
        if (input.waveId !== undefined) return refusal("wave_limit", `Wave ${input.waveId} is not registered by an active plan`);
      } else if (parent === undefined) {
        if (binding === undefined) return refusal("invalid_input", `Task ${input.taskId} is not registered by the active plan`);
        if (binding.parentTaskId !== undefined || binding.entity !== input.entity || binding.role !== input.role || !sameStrings(binding.scopeIds, requestedScopes)) return refusal("invalid_input", `Task ${input.taskId} does not match its active plan binding`);
        effectiveWaveId = binding.waveId; coverageCells = binding.coverage;
        if (input.waveId !== undefined && input.waveId !== effectiveWaveId) return refusal("wave_limit", "Root task wave does not match the active plan");
      } else {
        if (parent.planHash !== plan.planHash || parent.planVersion !== plan.planVersion) return refusal("role_violation", "Parent is not bound to the active plan");
        effectiveWaveId = parent.waveId;
        if (input.waveId !== undefined && input.waveId !== effectiveWaveId) return refusal("wave_limit", "Child wave must inherit its parent wave");
        if (binding !== undefined) {
          if (binding.parentTaskId !== parent.taskId || binding.entity !== input.entity || binding.role !== input.role || !sameStrings(binding.scopeIds, requestedScopes) || (binding.waveId !== undefined && binding.waveId !== effectiveWaveId)) return refusal("invalid_input", `Task ${input.taskId} does not match its active plan binding`);
          coverageCells = binding.coverage;
        } else {
          const parentBinding = plan.assignments[parent.taskId];
          if (parentBinding === undefined || parent.role !== "coordinator" || parentBinding.allowDynamicChildren !== true || parentBinding.delegatedCoverage === undefined) return refusal("invalid_input", "Dynamic child is outside a registered coordinator envelope");
          coverageCells = (parentBinding.delegatedCoverage ?? []).filter((cell) => requestedScopes.includes(cell.scopeId));
        }
      }
      if (effectiveWaveId !== undefined && plan?.waves[effectiveWaveId] === undefined) return refusal("wave_limit", `Wave ${effectiveWaveId} is not registered by the active plan`);
      const rawKey = input.idempotencyKey ?? `${input.taskId}\u0000${input.attempt}`;
      const key = `${parentDispatchId ?? "root"}\u0000${rawKey}`;
      const selectedModelRounds = hostOptions.modelRounds ?? state.config.roleCeilings[input.role].modelRoundsDefault;
      if (!Number.isSafeInteger(selectedModelRounds) || selectedModelRounds < 1 || selectedModelRounds > state.config.roleCeilings[input.role].modelRoundsMax) return refusal("invalid_input", `Host-selected model rounds must be within 1..${state.config.roleCeilings[input.role].modelRoundsMax}`);
      const existing = state.idempotency[key];
      if (existing !== undefined) {
        const prior = state.assignments[existing];
        const normalizedTask = input.task?.trim() || input.taskId;
        const requestedRuntimeMs = Math.min(input.maxRuntimeMs ?? state.config.roleCeilings[input.role].elapsedMs, state.config.roleCeilings[input.role].elapsedMs);
        const matches = prior !== undefined && prior.parentDispatchId === parentDispatchId && prior.taskId === input.taskId && prior.task === normalizedTask && prior.attempt === input.attempt && prior.entity === input.entity && prior.role === input.role && prior.adapterId === input.adapterId && prior.skillRef === input.skillRef && prior.waveId === effectiveWaveId && prior.planHash === plan?.planHash && prior.planVersion === plan?.planVersion && prior.budgetClass === (hostOptions.budgetClass ?? "ordinary") && prior.requestedRuntimeMs === requestedRuntimeMs && prior.selectedModelRounds === selectedModelRounds && sameStrings(prior.scopeIds, requestedScopes);
        return matches ? { ok: true, dispatchId: existing, reused: true } satisfies ReviewAgentAdmission : refusal("invalid_input", "Idempotency key was already claimed by a different immutable assignment");
      }
      const depth = (parent?.depth ?? 0) + 1;
      if (depth > state.config.runCeilings.maxDepth) return refusal("depth_limit", `Depth ${depth} exceeds ${state.config.runCeilings.maxDepth}`);
      if (parent !== undefined) {
        const parentPolicy = await this.policy(parent.entity);
        if (parent.role !== "coordinator" || input.role === "coordinator" || parentPolicy === undefined || !parentPolicy.allowedChildren.includes(input.entity)) return refusal("role_violation", `Parent ${parent.entity} cannot spawn ${input.entity}`);
        if (parent.children.length >= state.config.roleCeilings.coordinator.maxChildLaunches) return refusal("child_limit", "Coordinator child launch limit reached");
        const activeChildren = parent.children.filter((id) => { const child = state.assignments[id]; return child !== undefined && occupiesCapacity(child); }).length;
        if (activeChildren >= state.config.runCeilings.maxActiveChildrenPerGeneral) return refusal("child_limit", "Coordinator active child limit reached");
      }
      if (state.usedLaunches >= state.config.runCeilings.maxLaunches) return refusal("launch_limit", "Run launch limit reached");
      if (effectiveWaveId === undefined && state.outsideWaveLaunches >= state.config.runCeilings.maxLaunchesOutsideWaves) return refusal("launch_limit", "Outside-wave launch limit reached");
      if (effectiveWaveId !== undefined) {
        const waveCount = state.waveLaunches[effectiveWaveId] ?? 0;
        if (waveCount >= state.config.runCeilings.maxLaunchesPerWave) return refusal("wave_limit", `Wave ${effectiveWaveId} launch limit reached`);
      }
      if (input.role === "coordinator") {
        const generals = Object.values(state.assignments).filter((record) => record.role === "coordinator" && occupiesCapacity(record)).length;
        if (generals >= state.config.runCeilings.maxIncompleteGenerals) return refusal("general_limit", "Incomplete coordinator limit reached");
      }
      const roleLimits = state.config.roleCeilings[input.role];
      const reservationMs = Math.min(input.maxRuntimeMs ?? roleLimits.elapsedMs, roleLimits.elapsedMs);
      if (!Number.isSafeInteger(reservationMs) || reservationMs < 1) return refusal("invalid_input", "maxRuntimeMs must be a positive safe integer");
      const fraction = hostOptions.budgetClass === "reserved" ? 1 : 1 - state.config.runCeilings.reserveFraction;
      const timeCeiling = Math.floor(state.config.runCeilings.maxAgentTimeMs * fraction);
      if (state.usedActiveAgentTimeMs + state.reservedAgentTimeMs + reservationMs > timeCeiling) return refusal("time_limit", "Agent-time budget is exhausted for this budget class");
      const dispatchId = candidateDispatchId;
      const createdAt = nowIso(this.clock);
      const record: ReviewAgentAssignmentRecord = {
        dispatchId, taskId: input.taskId, task: input.task?.trim() || input.taskId, attempt: input.attempt, idempotencyKey: key,
        entity: input.entity, role: input.role, adapterId: input.adapterId, scopeIds: [...requestedScopes],
        budgetClass: hostOptions.budgetClass ?? "ordinary", depth, status: "queued", children: [], reservationMs, requestedRuntimeMs: reservationMs, selectedModelRounds, usedActiveMs: 0,
        createdAt, updatedAt: createdAt,
        ...(input.skillRef === undefined ? {} : { skillRef: input.skillRef }),
        ...(effectiveWaveId === undefined ? {} : { waveId: effectiveWaveId }),
        ...(plan === null ? {} : { planHash: plan.planHash, planVersion: plan.planVersion, coverageCells: clone(coverageCells ?? []) }),
        ...(parentDispatchId === undefined ? {} : { parentDispatchId }),
        ...(authorityRef === undefined ? {} : { authorityRef }),
      };
      state.assignments[dispatchId] = record;
      state.idempotency[key] = dispatchId;
      state.usedLaunches += 1;
      state.reservedAgentTimeMs += reservationMs;
      if (effectiveWaveId === undefined) state.outsideWaveLaunches += 1;
      else state.waveLaunches[effectiveWaveId] = (state.waveLaunches[effectiveWaveId] ?? 0) + 1;
      if (parent !== undefined) parent.children.push(dispatchId);
      return { ok: true, dispatchId, reused: false } satisfies ReviewAgentAdmission;
    });
    if (admission.ok && !admission.reused) await this.pump();
    return admission;
  }

  async wait(dispatchId: string, options: { signal?: AbortSignal } = {}): Promise<ReviewAgentTerminalResult> {
    while (true) {
      options.signal?.throwIfAborted();
      const record = await this.status(dispatchId);
      if (record === undefined || !("dispatchId" in record)) throw new Error(`Unknown assignment ${dispatchId}`);
      if (terminal(record)) {
        const execution = this.executions.get(dispatchId);
        if (execution !== undefined) { await execution; continue; }
        return terminalResult(record);
      }
      await reviewAgentsAbortableDelay(5, options.signal);
    }
  }

  async result(dispatchId: string): Promise<ReviewAgentStoredResult | undefined> {
    this.state = await readReviewAgentState(this.storageDir);
    const authorityRef = this.state.assignments[dispatchId]?.authorityRef;
    if (!authorityAllowed(await this.authority.authorize({ operation: "read_result", runId: this.state.runId, dispatchId, ...(authorityRef === undefined ? {} : { authorityRef }) }))) return undefined;
    const resultId = this.state.assignments[dispatchId]?.resultId;
    return resultId === undefined ? undefined : clone(this.state.results[resultId]);
  }

  async coverage(): Promise<readonly ReviewAgentCoverageRecord[]> {
    this.state = await readReviewAgentState(this.storageDir);
    return Object.values(this.state.coverage).map(clone);
  }

  async recordCoverage(input: Omit<ReviewAgentCoverageRecord, "key" | "recordedAt">): Promise<boolean> {
    this.state = await readReviewAgentState(this.storageDir);
    const authorityRef = this.state.assignments[input.dispatchId]?.authorityRef;
    if (!authorityAllowed(await this.authority.authorize({ operation: "record_coverage", runId: this.state.runId, dispatchId: input.dispatchId, ...(authorityRef === undefined ? {} : { authorityRef }) }))) return false;
    return this.modify((state) => {
      const assignment = state.assignments[input.dispatchId];
      if (assignment === undefined || !terminal(assignment) || !input.scopeId.trim() || !input.aspect.trim() || !assignment.scopeIds.includes(input.scopeId)) return false;
      if (state.activePlan !== null && (assignment.planHash !== state.activePlan.planHash || assignment.planVersion !== state.activePlan.planVersion || !assignment.coverageCells?.some((cell) => cell.scopeId === input.scopeId && cell.aspect === input.aspect))) return false;
      if (input.status === "result") {
        if (assignment.status !== "completed" || input.resultId === undefined || assignment.resultId !== input.resultId || input.evidence === undefined || input.evidence.length === 0) return false;
        const stored = state.results[input.resultId];
        if (stored === undefined || stored.dispatchId !== input.dispatchId || stored.revision !== state.revision || !stored.scopeIds.includes(input.scopeId)) return false;
        if (state.activePlan !== null && (stored.planHash !== state.activePlan.planHash || stored.planVersion !== state.activePlan.planVersion)) return false;
      } else if (input.resultId !== undefined || input.evidence !== undefined) return false;
      const key = `${input.scopeId}\u0000${input.aspect}`;
      state.coverage[key] = { ...clone(input), key, recordedAt: nowIso(this.clock), ...(assignment.planHash === undefined ? {} : { planHash: assignment.planHash, planVersion: assignment.planVersion }) };
      return true;
    });
  }

  async cancel(dispatchId: string | undefined, reason: string): Promise<void> {
    this.state = await readReviewAgentState(this.storageDir);
    const authorityRef = dispatchId === undefined ? undefined : this.state.assignments[dispatchId]?.authorityRef;
    if (!authorityAllowed(await this.authority.authorize({ operation: "cancel", runId: this.state.runId, ...(dispatchId === undefined ? {} : { dispatchId }), ...(authorityRef === undefined ? {} : { authorityRef }) }))) throw new Error("The effective host authority denied cancellation");
    await this.cancelTree(dispatchId, reason);
  }

  private async cancelTree(dispatchId: string | undefined, reason: string): Promise<void> {
    const cancelling = await this.modify((state) => {
      const roots = dispatchId === undefined ? Object.keys(state.assignments).filter((id) => state.assignments[id]?.parentDispatchId === undefined) : [dispatchId];
      const ids: string[] = []; const active: string[] = [];
      const visit = (id: string) => { const record = state.assignments[id]; if (record === undefined || ids.includes(id)) return; ids.push(id); for (const child of record.children) visit(child); };
      roots.forEach(visit);
      for (const id of ids) {
        const record = state.assignments[id]; if (record === undefined || (terminal(record) && record.status !== "unresolved")) continue;
        const mayHaveProcess = this.runningExecutions.has(id) || record.status !== "queued";
        record.cancelReason = reason; record.error = reason; record.updatedAt = nowIso(this.clock);
        this.finishActiveSegment(state, record);
        if (mayHaveProcess) { record.status = "cancelling"; active.push(id); }
        else { this.releaseReservation(state, record); record.status = "cancelled"; }
      }
      if (dispatchId === undefined) state.status = "cancelled";
      return { ids, active };
    });
    for (const id of cancelling.ids) {
      this.aborts.get(id)?.abort(new Error(reason));
      this.resumeWaiters.get(id)?.resolve(false);
    }
    await Promise.all(cancelling.active.map(async (id) => {
      const record = this.state.assignments[id]; const adapter = record === undefined ? undefined : this.adapters.get(record.adapterId);
      let confirmed = false;
      try {
        if (adapter?.cancel !== undefined) {
          confirmed = await Promise.race([
            adapter.cancel({ runId: this.state.runId, dispatchId: id, reason }).then(() => true),
            reviewAgentsAbortableDelay(this.cancelCleanupTimeoutMs).then(() => false),
          ]);
        }
      }
      catch { confirmed = false; }
      await this.modify((state) => {
        const current = state.assignments[id];
        if (current === undefined || current.status !== "cancelling") return;
        if (confirmed) { this.releaseReservation(state, current); current.status = "cancelled"; }
        else current.status = "unresolved";
        current.error = confirmed ? reason : `unresolved_process: ${reason}`; current.updatedAt = nowIso(this.clock);
      });
      if (confirmed) { this.deadlines.get(id)?.stop(); this.deadlines.delete(id); }
    }));
    await this.pump();
  }

  async reconcile(): Promise<void> {
    this.state = await readReviewAgentState(this.storageDir);
    const unresolved = Object.values(this.state.assignments).filter((record) => (record.status === "unresolved" || (!terminal(record) && record.status !== "queued")) && !this.runningExecutions.has(record.dispatchId));
    for (const record of unresolved) {
      const probe = this.adapters.get(record.adapterId)?.reconcile?.({ runId: this.state.runId, dispatchId: record.dispatchId });
      const verdict = probe === undefined ? "unknown" : await Promise.race([probe, reviewAgentsAbortableDelay(this.reconcileTimeoutMs).then(() => "unknown" as const)]);
      if (verdict === "running") { this.armRecoveredDeadline(record); continue; }
      await this.modify((state) => {
        const current = state.assignments[record.dispatchId]; if (current === undefined || (terminal(current) && current.status !== "unresolved")) return;
        this.finishActiveSegment(state, current);
        if (verdict === "cancelled") { this.releaseReservation(state, current); current.status = "cancelled"; }
        else current.status = "unresolved";
        current.error = verdict === "cancelled" ? "adapter reported cancellation during reconciliation" : "unresolved_process";
        current.updatedAt = nowIso(this.clock);
      });
      if (verdict === "unknown") {
        const current = this.state.assignments[record.dispatchId]; if (current !== undefined) this.armRecoveredDeadline(current);
      }
    }
    await this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const next = await this.modify((state) => {
          const runElapsedMs = this.clock().getTime() - new Date(state.createdAt).getTime();
          if (runElapsedMs >= state.config.runCeilings.elapsedDeadlineMs) {
            for (const queued of Object.values(state.assignments).filter((record) => record.status === "queued")) {
              this.releaseReservation(state, queued); queued.status = "blocked"; queued.error = "run_elapsed_deadline"; queued.updatedAt = nowIso(this.clock);
            }
            return undefined;
          }
          const active = Object.values(state.assignments).filter((record) => record.status === "running" || record.status === "collecting" || record.status === "cancelling" || record.status === "unresolved").length;
          const ceiling = Math.min(state.config.runCeilings.initialConcurrency, state.config.runCeilings.maxActiveDescendants);
          if (active >= ceiling) return undefined;
          const queued = Object.values(state.assignments).filter((candidate) => candidate.status === "queued");
          const record = queued.find((candidate) => this.runningExecutions.has(candidate.dispatchId))
            ?? queued.find((candidate) => candidate.role === "validator")
            ?? queued[0];
          if (record === undefined) return undefined;
          record.status = this.runningExecutions.has(record.dispatchId) ? "collecting" : "running";
          record.activeStartedAt = nowIso(this.clock); record.updatedAt = record.activeStartedAt;
          return { dispatchId: record.dispatchId, resume: this.runningExecutions.has(record.dispatchId) };
        });
        if (next === undefined) break;
        if (next.resume) this.resumeWaiters.get(next.dispatchId)?.resolve(true);
        else {
          this.runningExecutions.add(next.dispatchId);
          const execution = this.execute(next.dispatchId).catch(() => undefined);
          this.executions.set(next.dispatchId, execution);
          void execution.finally(() => { this.executions.delete(next.dispatchId); });
        }
      }
    } finally { this.pumping = false; }
  }

  private armRecoveredDeadline(record: ReviewAgentAssignmentRecord): void {
    if (this.deadlines.has(record.dispatchId) || record.status === "cancelled") return;
    const ageMs = Math.max(0, this.clock().getTime() - new Date(record.createdAt).getTime());
    const assignmentRemainingMs = Math.max(1, record.requestedRuntimeMs - ageMs);
    const runAgeMs = Math.max(0, this.clock().getTime() - new Date(this.state.createdAt).getTime());
    const runRemainingMs = Math.max(1, this.state.config.runCeilings.elapsedDeadlineMs - runAgeMs);
    const deadline = createReviewAgentDeadline({
      assignmentRemainingMs, runRemainingMs, now: () => this.clock().getTime(),
      onExpire: async (kind) => this.cancelTree(record.dispatchId, `${kind}_runtime_limit`),
    });
    this.deadlines.set(record.dispatchId, deadline);
  }

  private async execute(dispatchId: string): Promise<void> {
    const record = this.state.assignments[dispatchId] ?? (await readReviewAgentState(this.storageDir)).assignments[dispatchId];
    const adapter = record === undefined ? undefined : this.adapters.get(record.adapterId);
    if (record === undefined || adapter === undefined) return;
    const rawRunRemainingMs = this.state.config.runCeilings.elapsedDeadlineMs - (this.clock().getTime() - new Date(this.state.createdAt).getTime());
    if (rawRunRemainingMs <= 0) {
      await this.modify((state) => {
        const current = state.assignments[dispatchId]; if (current === undefined || terminal(current)) return;
        this.finishActiveSegment(state, current); this.releaseReservation(state, current);
        current.status = "blocked"; current.error = "run_elapsed_deadline"; current.updatedAt = nowIso(this.clock);
      });
      this.runningExecutions.delete(dispatchId); await this.pump(); return;
    }
    const abort = new AbortController(); this.aborts.set(dispatchId, abort);
    const assignmentRemainingMs = Math.max(1, record.requestedRuntimeMs - record.usedActiveMs);
    const runRemainingMs = rawRunRemainingMs;
    const deadline = createReviewAgentDeadline({
      assignmentRemainingMs, runRemainingMs, now: () => this.clock().getTime(),
      onExpire: async (kind) => this.cancelTree(dispatchId, `${kind}_runtime_limit`),
    });
    this.deadlines.set(dispatchId, deadline);
    const request: ReviewAgentAdapterRequest = {
      runId: this.state.runId, dispatchId, taskId: record.taskId, task: record.task, attempt: record.attempt,
      revision: this.state.revision, entity: record.entity, role: record.role, scopeIds: record.scopeIds,
      depth: record.depth, limits: { ...clone(this.state.config.roleCeilings[record.role]), elapsedMs: record.requestedRuntimeMs, modelRoundsDefault: record.selectedModelRounds }, signal: abort.signal,
      ...(record.skillRef === undefined ? {} : { skillRef: record.skillRef }),
      ...(record.parentDispatchId === undefined ? {} : { parentDispatchId: record.parentDispatchId }),
      ...(record.planHash === undefined ? {} : { planHash: record.planHash, planVersion: record.planVersion }),
    };
    const context: ReviewAgentAdapterContext = {
      signal: abort.signal,
      controller: this.scoped(dispatchId),
      spawnChild: async (input) => (await this.spawnChildrenFrom(dispatchId, [input]))[0]!,
      spawnChildren: async (inputs) => this.spawnChildrenFrom(dispatchId, inputs),
    };
    try {
      const output = await adapter.execute(request, context);
      await this.modify((state) => {
        const current = state.assignments[dispatchId]; if (current === undefined) return;
        if (current.status === "cancelling" || current.status === "unresolved") {
          this.finishActiveSegment(state, current); this.releaseReservation(state, current); current.status = "cancelled"; current.error = current.cancelReason ?? "cancelled"; current.updatedAt = nowIso(this.clock); return;
        }
        if (terminal(current)) return;
        if (this.cancelIfAssignmentElapsed(state, current)) return;
        this.finishActiveSegment(state, current); this.releaseReservation(state, current);
        const resultStatus = reviewAgentResultStatus(output.content);
        if (resultStatus === "blocked") {
          current.status = "blocked"; current.error = "review_result_blocked";
          current.updatedAt = nowIso(this.clock); return;
        }
        const resultId = this.id();
        const stored: ReviewAgentStoredResult = {
          resultId, dispatchId, runId: state.runId, taskId: current.taskId, attempt: current.attempt,
          revision: state.revision, entity: current.entity, scopeIds: [...current.scopeIds], content: clone(output.content), createdAt: nowIso(this.clock),
          ...(current.planHash === undefined ? {} : { planHash: current.planHash, planVersion: current.planVersion }),
          ...(current.skillRef === undefined ? {} : { skillRef: current.skillRef }),
          ...(output.usage === undefined ? {} : { usage: clone(output.usage) }),
          ...(output.metadata === undefined ? {} : { metadata: clone(output.metadata) }),
        };
        state.results[resultId] = stored; current.resultId = resultId; current.status = resultStatus; current.updatedAt = nowIso(this.clock);
      });
    } catch (error) {
      await this.modify((state) => {
        const current = state.assignments[dispatchId]; if (current === undefined) return;
        if (current.status === "cancelling" || current.status === "unresolved") {
          this.finishActiveSegment(state, current); this.releaseReservation(state, current); current.status = "cancelled"; current.error = current.cancelReason ?? "cancelled"; current.updatedAt = nowIso(this.clock); return;
        }
        if (terminal(current)) return;
        if (this.cancelIfAssignmentElapsed(state, current)) return;
        this.finishActiveSegment(state, current); this.releaseReservation(state, current);
        current.status = abort.signal.aborted ? "cancelled" : "failed";
        current.error = error instanceof Error ? error.message : String(error); current.updatedAt = nowIso(this.clock);
      });
    } finally {
      deadline.stop(); this.deadlines.delete(dispatchId);
      this.runningExecutions.delete(dispatchId); this.aborts.delete(dispatchId); this.resumeWaiters.delete(dispatchId); await this.pump();
    }
  }

  private async spawnChildrenFrom(parentId: string, inputs: readonly ReviewAgentSpawnInput[]): Promise<readonly ReviewAgentTerminalResult[]> {
    if (inputs.length === 0) return [];
    await this.modify((state) => {
      const parent = state.assignments[parentId];
      if (parent === undefined || parent.role !== "coordinator" || terminal(parent)) throw new Error(`Assignment ${parentId} cannot delegate`);
      if (parent.status === "running" || parent.status === "collecting") {
        this.finishActiveSegment(state, parent); this.releaseReservation(state, parent); parent.status = "waiting_children"; parent.updatedAt = nowIso(this.clock);
      }
    });
    const admitted: string[] = [];
    for (const input of inputs) {
      const admission = await this.spawnInternal(input, parentId);
      if (!admission.ok) {
        await Promise.all(admitted.map((id) => this.cancelTree(id, `batch admission rollback: ${admission.code}`)));
        await Promise.all(admitted.map((id) => this.wait(id)));
        await this.reacquire(parentId);
        throw new Error(`Child admission refused (${admission.code}): ${admission.message}`);
      }
      admitted.push(admission.dispatchId);
    }
    return this.waitChildrenFrom(parentId, admitted, false);
  }

  private async waitChildrenFrom(parentId: string, dispatchIds: readonly string[], transition = true): Promise<readonly ReviewAgentTerminalResult[]> {
    if (transition) {
      await this.modify((state) => {
        const parent = state.assignments[parentId];
        if (parent === undefined || parent.role !== "coordinator" || terminal(parent)) throw new Error(`Assignment ${parentId} cannot wait for children`);
        if (parent.status === "running" || parent.status === "collecting") {
          this.finishActiveSegment(state, parent); this.releaseReservation(state, parent); parent.status = "waiting_children"; parent.updatedAt = nowIso(this.clock);
        }
      });
      await this.pump();
    }
    const results = await Promise.all(dispatchIds.map((id) => this.wait(id)));
    const reacquired = await this.reacquire(parentId);
    if (!reacquired) throw new Error(`Coordinator ${parentId} was cancelled while waiting for children`);
    return results;
  }

  private async reacquire(dispatchId: string): Promise<boolean> {
    const gate = deferred<boolean>(); this.resumeWaiters.set(dispatchId, gate);
    const queued = await this.modify((state) => {
      const record = state.assignments[dispatchId]; if (record === undefined || terminal(record)) return false;
      const remaining = Math.max(1, record.requestedRuntimeMs - record.usedActiveMs);
      const fraction = record.budgetClass === "reserved" ? 1 : 1 - state.config.runCeilings.reserveFraction;
      if (state.usedActiveAgentTimeMs + state.reservedAgentTimeMs + remaining > Math.floor(state.config.runCeilings.maxAgentTimeMs * fraction)) {
        record.status = "blocked"; record.error = "agent_time_exhausted_before_continuation"; record.updatedAt = nowIso(this.clock); return false;
      }
      record.reservationMs = remaining; state.reservedAgentTimeMs += remaining; record.status = "queued"; record.updatedAt = nowIso(this.clock); return true;
    });
    if (!queued) { this.resumeWaiters.delete(dispatchId); return false; }
    await this.pump(); return gate.promise;
  }

  private finishActiveSegment(state: ReviewAgentRunState, record: ReviewAgentAssignmentRecord): void {
    if (record.activeStartedAt === undefined) return;
    const duration = Math.max(0, this.clock().getTime() - new Date(record.activeStartedAt).getTime());
    record.usedActiveMs += duration; state.usedActiveAgentTimeMs += duration; delete record.activeStartedAt;
  }
  private releaseReservation(state: ReviewAgentRunState, record: ReviewAgentAssignmentRecord): void {
    state.reservedAgentTimeMs = Math.max(0, state.reservedAgentTimeMs - record.reservationMs); record.reservationMs = 0;
  }
  private cancelIfAssignmentElapsed(state: ReviewAgentRunState, record: ReviewAgentAssignmentRecord): boolean {
    const assignmentExpiresAt = new Date(record.createdAt).getTime() + record.requestedRuntimeMs;
    if (this.clock().getTime() < assignmentExpiresAt) return false;
    const reason = "assignment_runtime_limit";
    this.finishActiveSegment(state, record); this.releaseReservation(state, record);
    record.cancelReason = reason; record.status = "cancelled"; record.error = reason; record.updatedAt = nowIso(this.clock);
    return true;
  }
  private async modify<T>(fn: (state: ReviewAgentRunState) => T | Promise<T>): Promise<T> {
    if (this.ownerId === undefined || this.fencingToken === undefined) throw new Error("This Review agents controller is read-only");
    if (this.closed) throw new Error("This Review agents controller is closed");
    if (this.leaseFailure !== undefined) throw new Error("Review agents controller lease renewal failed", { cause: this.leaseFailure });
    const result = await mutateReviewAgentState(this.storageDir, this.fencingToken, async (state) => { const value = await fn(state); state.updatedAt = nowIso(this.clock); return value; }, this.clock().getTime());
    this.state = result.state; return result.value;
  }
}

export { createLargeReviewConfig };
