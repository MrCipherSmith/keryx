export const REVIEW_AGENTS_STATE_VERSION = 1 as const;
export const REVIEW_AGENTS_CONFIG_VERSION = 1 as const;

export type ReviewAgentRole = "coordinator" | "worker" | "scout" | "validator";
export type ReviewAgentAssignmentStatus =
  | "queued"
  | "running"
  | "waiting_children"
  | "collecting"
  | "cancelling"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "unresolved";
export type ReviewAgentRunStatus = "active" | "cancelled" | "completed";

export interface ReviewAgentRunCeilings {
  readonly maxActiveDescendants: number;
  readonly initialConcurrency: number;
  readonly maxIncompleteGenerals: number;
  readonly maxActiveChildrenPerGeneral: number;
  readonly maxLaunches: number;
  readonly maxLaunchesPerWave: number;
  readonly maxLaunchesOutsideWaves: number;
  readonly maxWaves: number;
  readonly maxAgentTimeMs: number;
  readonly elapsedDeadlineMs: number;
  readonly reserveFraction: number;
  readonly maxReviewRounds: number;
  readonly maxDepth: number;
}

export interface ReviewAgentRoleCeiling {
  readonly elapsedMs: number;
  readonly modelRoundsDefault: number;
  readonly modelRoundsMax: number;
  readonly toolCallsMax: number;
  readonly maxChildLaunches: number;
}

export interface ReviewAgentConfig {
  readonly configVersion: 1;
  readonly profile: "large-review" | string;
  readonly runCeilings: ReviewAgentRunCeilings;
  readonly roleCeilings: Readonly<Record<"root" | ReviewAgentRole, ReviewAgentRoleCeiling>>;
  readonly allowedAdapters?: readonly string[];
  readonly allowedEntities?: readonly string[];
  readonly allowedSkills?: readonly string[];
  readonly fallbackPolicy: "refuse" | "ask" | "preapproved";
  readonly costMode: "measured-cost" | "cost-unknown";
  readonly spendingCeiling?: { readonly amount: number; readonly currency: string };
}

export interface ReviewAgentConfigOverrides {
  readonly profile?: string;
  readonly runCeilings?: Partial<ReviewAgentRunCeilings>;
  readonly roleCeilings?: Partial<Record<"root" | ReviewAgentRole, Partial<ReviewAgentRoleCeiling>>>;
  readonly allowedAdapters?: readonly string[];
  readonly allowedEntities?: readonly string[];
  readonly allowedSkills?: readonly string[];
  readonly fallbackPolicy?: ReviewAgentConfig["fallbackPolicy"];
  readonly costMode?: ReviewAgentConfig["costMode"];
  readonly spendingCeiling?: ReviewAgentConfig["spendingCeiling"];
}

export interface ReviewAgentAdapterCapabilities {
  readonly readOnlyEnforced: boolean;
  readonly resultPersistence: boolean;
  readonly cancellation: boolean;
  readonly hierarchy: boolean;
  readonly usageAccounting?: boolean;
  /** True only when the adapter enforces a controller-supplied cost ceiling before provider spend. */
  readonly costEnforcement?: boolean;
  /** Tool surface actually exposed by the adapter; bridge-only generals orchestrate but cannot inspect source directly. */
  readonly toolProfile?: "full" | "bridge-only";
  readonly sourceRead?: boolean;
  /** Whether provider credentials can be refreshed safely during an active dispatch. */
  readonly authRefresh?: boolean;
}

export interface ReviewAgentSpawnInput {
  readonly taskId: string;
  readonly task?: string;
  readonly attempt: number;
  readonly idempotencyKey?: string;
  readonly entity: string;
  readonly role: ReviewAgentRole;
  readonly adapterId: string;
  readonly skillRef?: string;
  readonly scopeIds?: readonly string[];
  readonly waveId?: string;
  readonly maxRuntimeMs?: number;
}

export interface ReviewAgentAdapterRequest {
  readonly runId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly task: string;
  readonly attempt: number;
  readonly revision: string;
  readonly planHash?: string;
  readonly planVersion?: number;
  readonly entity: string;
  readonly role: ReviewAgentRole;
  readonly skillRef?: string;
  readonly scopeIds: readonly string[];
  readonly parentDispatchId?: string;
  readonly depth: number;
  readonly limits: ReviewAgentRoleCeiling;
  readonly signal: AbortSignal;
}

export interface ReviewAgentAdapterUsage {
  readonly modelRounds?: number;
  readonly toolCalls?: number;
  readonly activeMs?: number;
  readonly cost?: { readonly amount: number; readonly currency: string };
}

export interface ReviewAgentAdapterResult {
  readonly content: unknown;
  readonly usage?: ReviewAgentAdapterUsage;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReviewAgentTerminalResult {
  readonly dispatchId: string;
  readonly status: Extract<ReviewAgentAssignmentStatus, "completed" | "blocked" | "failed" | "cancelled" | "unresolved">;
  readonly resultId?: string;
  readonly error?: string;
}

export interface ReviewAgentAdapterContext {
  readonly signal: AbortSignal;
  readonly controller: ReviewAgentScopedController;
  readonly spawnChild: (input: ReviewAgentSpawnInput) => Promise<ReviewAgentTerminalResult>;
  readonly spawnChildren: (inputs: readonly ReviewAgentSpawnInput[]) => Promise<readonly ReviewAgentTerminalResult[]>;
}

export interface ReviewAgentScopedController {
  readonly spawn: (input: ReviewAgentSpawnInput) => Promise<ReviewAgentAdmission>;
  readonly status: (dispatchId: string) => Promise<ReviewAgentAssignmentRecord | undefined>;
  readonly wait: (dispatchId: string, options?: { signal?: AbortSignal }) => Promise<ReviewAgentTerminalResult>;
  readonly result: (dispatchId: string) => Promise<ReviewAgentStoredResult | undefined>;
  readonly cancel: (dispatchId: string, reason: string) => Promise<void>;
  /** Releases the coordinator execution slot while the named descendants settle, then reacquires it. */
  readonly waitChildren: (dispatchIds: readonly string[]) => Promise<readonly ReviewAgentTerminalResult[]>;
}

export interface ReviewAgentAdapter {
  readonly id: string;
  readonly capabilities: ReviewAgentAdapterCapabilities;
  readonly execute: (request: ReviewAgentAdapterRequest, context: ReviewAgentAdapterContext) => Promise<ReviewAgentAdapterResult>;
  readonly cancel?: (request: { readonly runId: string; readonly dispatchId: string; readonly reason: string }) => Promise<void>;
  readonly reconcile?: (request: { readonly runId: string; readonly dispatchId: string }) => Promise<"running" | "cancelled" | "unknown">;
}

export type ReviewAgentAuthorityOperation = "spawn" | "cancel" | "read_result" | "record_coverage" | "register_plan";
export interface ReviewAgentAuthorityRequest {
  readonly operation: ReviewAgentAuthorityOperation;
  readonly runId: string;
  readonly dispatchId?: string;
  readonly parentDispatchId?: string;
  readonly entity?: string;
  readonly adapterId?: string;
  readonly planHash?: string;
  readonly planVersion?: number;
  /** Opaque host-issued lease inherited from the parent; never accepted from model or CLI payloads. */
  readonly authorityRef?: string;
}
export type ReviewAgentAuthorityDecision = boolean | { readonly allowed: boolean; readonly authorityRef?: string };
export interface ReviewAgentAuthority {
  readonly authorize: (request: ReviewAgentAuthorityRequest) => ReviewAgentAuthorityDecision | Promise<ReviewAgentAuthorityDecision>;
}

export interface ReviewAgentEntityPolicy {
  readonly name: string;
  readonly role: ReviewAgentRole;
  readonly allowedSkills: readonly string[];
  readonly allowedChildren: readonly string[];
}

export interface ReviewAgentEntityPolicyResolver {
  readonly resolve: (entity: string) => ReviewAgentEntityPolicy | undefined | Promise<ReviewAgentEntityPolicy | undefined>;
}

export interface ReviewAgentAssignmentRecord {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly task: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly entity: string;
  readonly role: ReviewAgentRole;
  readonly adapterId: string;
  readonly skillRef?: string;
  readonly scopeIds: readonly string[];
  readonly waveId?: string;
  readonly planHash?: string;
  readonly planVersion?: number;
  readonly coverageCells?: readonly { readonly scopeId: string; readonly aspect: string }[];
  readonly budgetClass: "ordinary" | "reserved";
  readonly parentDispatchId?: string;
  readonly authorityRef?: string;
  readonly depth: number;
  status: ReviewAgentAssignmentStatus;
  readonly children: string[];
  reservationMs: number;
  readonly requestedRuntimeMs: number;
  readonly selectedModelRounds: number;
  usedActiveMs: number;
  activeStartedAt?: string;
  readonly createdAt: string;
  updatedAt: string;
  resultId?: string;
  error?: string;
  cancelReason?: string;
}

export interface ReviewAgentStoredResult {
  readonly resultId: string;
  readonly dispatchId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly revision: string;
  readonly planHash?: string;
  readonly planVersion?: number;
  readonly entity: string;
  readonly skillRef?: string;
  readonly scopeIds: readonly string[];
  readonly content: unknown;
  readonly usage?: ReviewAgentAdapterUsage;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ReviewAgentCoverageRecord {
  readonly key: string;
  readonly scopeId: string;
  readonly aspect: string;
  readonly dispatchId: string;
  readonly status: "result" | "blocked" | "not_run";
  readonly resultId?: string;
  readonly evidence?: readonly string[];
  readonly planHash?: string;
  readonly planVersion?: number;
  readonly recordedAt: string;
}

export interface ReviewAgentRegisteredWave {
  readonly waveId: string;
  readonly planHash: string;
  readonly reviewRound: number;
  readonly registeredAt: string;
}

export interface ReviewAgentPlanAssignmentBinding {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly entity: string;
  readonly role: ReviewAgentRole;
  readonly scopeIds: readonly string[];
  readonly waveId?: string;
  readonly coverage: readonly { readonly scopeId: string; readonly aspect: string }[];
  readonly delegatedCoverage?: readonly { readonly scopeId: string; readonly aspect: string }[];
  readonly allowDynamicChildren?: boolean;
}

export interface ReviewAgentRegisterPlanInput {
  readonly planHash: string;
  readonly planVersion: number;
  readonly revision: string;
  readonly waves: readonly Omit<ReviewAgentRegisteredWave, "planHash" | "registeredAt">[];
  readonly assignments: readonly ReviewAgentPlanAssignmentBinding[];
}

export interface ReviewAgentRegisteredPlan {
  readonly planHash: string;
  readonly planVersion: number;
  readonly revision: string;
  readonly registeredAt: string;
  readonly waves: Readonly<Record<string, ReviewAgentRegisteredWave>>;
  readonly assignments: Readonly<Record<string, ReviewAgentPlanAssignmentBinding>>;
}

export interface ReviewAgentRunState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly revision: string;
  readonly config: ReviewAgentConfig;
  status: ReviewAgentRunStatus;
  readonly createdAt: string;
  updatedAt: string;
  controllerLease: { ownerId: string; fencingToken: string; expiresAt: string };
  usedLaunches: number;
  outsideWaveLaunches: number;
  usedActiveAgentTimeMs: number;
  reservedAgentTimeMs: number;
  readonly waveLaunches: Record<string, number>;
  readonly registeredWaves: Record<string, ReviewAgentRegisteredWave>;
  activePlan: ReviewAgentRegisteredPlan | null;
  highestReviewRound: number;
  readonly assignments: Record<string, ReviewAgentAssignmentRecord>;
  readonly idempotency: Record<string, string>;
  readonly results: Record<string, ReviewAgentStoredResult>;
  readonly coverage: Record<string, ReviewAgentCoverageRecord>;
}

export type ReviewAgentAdmission =
  | { readonly ok: true; readonly dispatchId: string; readonly reused: boolean }
  | { readonly ok: false; readonly code: "authority_denied" | "run_closed" | "adapter_missing" | "adapter_unsupported" | "entity_denied" | "skill_denied" | "depth_limit" | "role_violation" | "launch_limit" | "wave_limit" | "general_limit" | "child_limit" | "time_limit" | "invalid_input"; readonly message: string };

/** Host-only controls; never part of model or CLI spawn payload schemas. */
export interface ReviewAgentHostSpawnOptions {
  readonly modelRounds?: number;
  readonly budgetClass?: "ordinary" | "reserved";
}

export interface ReviewAgentControllerDependencies {
  readonly storageDir: string;
  readonly adapters: readonly ReviewAgentAdapter[];
  readonly authority: ReviewAgentAuthority;
  readonly entityPolicies?: ReviewAgentEntityPolicyResolver;
  readonly clock?: () => Date;
  readonly id?: () => string;
  /** Required for mutable ownership. Omit only for a read-only controller. */
  readonly ownerId?: string;
  readonly leaseMs?: number;
  /** Host-owned upper bound for adapter stop confirmation before the process becomes unresolved. */
  readonly cancelCleanupTimeoutMs?: number;
  /** Host-owned upper bound for one adapter reconciliation probe. */
  readonly reconcileTimeoutMs?: number;
}

export interface ReviewAgentCreateOptions extends ReviewAgentControllerDependencies {
  readonly ownerId: string;
  readonly runId: string;
  readonly revision: string;
  readonly config: ReviewAgentConfig;
}

export type ReviewAgentOpenOptions = ReviewAgentControllerDependencies;
