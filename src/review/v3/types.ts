export const REVIEW_V3_STATE_VERSION = 1 as const;
export const REVIEW_V3_CONFIG_VERSION = 1 as const;

export type ReviewV3Role = "coordinator" | "worker" | "scout" | "validator";
export type ReviewV3AssignmentStatus =
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
export type ReviewV3RunStatus = "active" | "cancelled" | "completed";

export interface ReviewV3RunCeilings {
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

export interface ReviewV3RoleCeiling {
  readonly elapsedMs: number;
  readonly modelRoundsDefault: number;
  readonly modelRoundsMax: number;
  readonly toolCallsMax: number;
  readonly maxChildLaunches: number;
}

export interface ReviewV3Config {
  readonly configVersion: 1;
  readonly profile: "large-review" | string;
  readonly runCeilings: ReviewV3RunCeilings;
  readonly roleCeilings: Readonly<Record<"root" | ReviewV3Role, ReviewV3RoleCeiling>>;
  readonly allowedAdapters?: readonly string[];
  readonly allowedEntities?: readonly string[];
  readonly allowedSkills?: readonly string[];
  readonly fallbackPolicy: "refuse" | "ask" | "preapproved";
  readonly costMode: "measured-cost" | "cost-unknown";
  readonly spendingCeiling?: { readonly amount: number; readonly currency: string };
}

export interface ReviewV3ConfigOverrides {
  readonly profile?: string;
  readonly runCeilings?: Partial<ReviewV3RunCeilings>;
  readonly roleCeilings?: Partial<Record<"root" | ReviewV3Role, Partial<ReviewV3RoleCeiling>>>;
  readonly allowedAdapters?: readonly string[];
  readonly allowedEntities?: readonly string[];
  readonly allowedSkills?: readonly string[];
  readonly fallbackPolicy?: ReviewV3Config["fallbackPolicy"];
  readonly costMode?: ReviewV3Config["costMode"];
  readonly spendingCeiling?: ReviewV3Config["spendingCeiling"];
}

export interface ReviewV3AdapterCapabilities {
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

export interface ReviewV3SpawnInput {
  readonly taskId: string;
  readonly task?: string;
  readonly attempt: number;
  readonly idempotencyKey?: string;
  readonly entity: string;
  readonly role: ReviewV3Role;
  readonly adapterId: string;
  readonly skillRef?: string;
  readonly scopeIds?: readonly string[];
  readonly waveId?: string;
  readonly maxRuntimeMs?: number;
}

export interface ReviewV3AdapterRequest {
  readonly runId: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly task: string;
  readonly attempt: number;
  readonly revision: string;
  readonly planHash?: string;
  readonly planVersion?: number;
  readonly entity: string;
  readonly role: ReviewV3Role;
  readonly skillRef?: string;
  readonly scopeIds: readonly string[];
  readonly parentDispatchId?: string;
  readonly depth: number;
  readonly limits: ReviewV3RoleCeiling;
  readonly signal: AbortSignal;
}

export interface ReviewV3AdapterUsage {
  readonly modelRounds?: number;
  readonly toolCalls?: number;
  readonly activeMs?: number;
  readonly cost?: { readonly amount: number; readonly currency: string };
}

export interface ReviewV3AdapterResult {
  readonly content: unknown;
  readonly usage?: ReviewV3AdapterUsage;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReviewV3TerminalResult {
  readonly dispatchId: string;
  readonly status: Extract<ReviewV3AssignmentStatus, "completed" | "blocked" | "failed" | "cancelled" | "unresolved">;
  readonly resultId?: string;
  readonly error?: string;
}

export interface ReviewV3AdapterContext {
  readonly signal: AbortSignal;
  readonly controller: ReviewV3ScopedController;
  readonly spawnChild: (input: ReviewV3SpawnInput) => Promise<ReviewV3TerminalResult>;
  readonly spawnChildren: (inputs: readonly ReviewV3SpawnInput[]) => Promise<readonly ReviewV3TerminalResult[]>;
}

export interface ReviewV3ScopedController {
  readonly spawn: (input: ReviewV3SpawnInput) => Promise<ReviewV3Admission>;
  readonly status: (dispatchId: string) => Promise<ReviewV3AssignmentRecord | undefined>;
  readonly wait: (dispatchId: string, options?: { signal?: AbortSignal }) => Promise<ReviewV3TerminalResult>;
  readonly result: (dispatchId: string) => Promise<ReviewV3StoredResult | undefined>;
  readonly cancel: (dispatchId: string, reason: string) => Promise<void>;
  /** Releases the coordinator execution slot while the named descendants settle, then reacquires it. */
  readonly waitChildren: (dispatchIds: readonly string[]) => Promise<readonly ReviewV3TerminalResult[]>;
}

export interface ReviewV3Adapter {
  readonly id: string;
  readonly capabilities: ReviewV3AdapterCapabilities;
  readonly execute: (request: ReviewV3AdapterRequest, context: ReviewV3AdapterContext) => Promise<ReviewV3AdapterResult>;
  readonly cancel?: (request: { readonly runId: string; readonly dispatchId: string; readonly reason: string }) => Promise<void>;
  readonly reconcile?: (request: { readonly runId: string; readonly dispatchId: string }) => Promise<"running" | "cancelled" | "unknown">;
}

export type ReviewV3AuthorityOperation = "spawn" | "cancel" | "read_result" | "record_coverage" | "register_plan";
export interface ReviewV3AuthorityRequest {
  readonly operation: ReviewV3AuthorityOperation;
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
export type ReviewV3AuthorityDecision = boolean | { readonly allowed: boolean; readonly authorityRef?: string };
export interface ReviewV3Authority {
  readonly authorize: (request: ReviewV3AuthorityRequest) => ReviewV3AuthorityDecision | Promise<ReviewV3AuthorityDecision>;
}

export interface ReviewV3EntityPolicy {
  readonly name: string;
  readonly role: ReviewV3Role;
  readonly allowedSkills: readonly string[];
  readonly allowedChildren: readonly string[];
}

export interface ReviewV3EntityPolicyResolver {
  readonly resolve: (entity: string) => ReviewV3EntityPolicy | undefined | Promise<ReviewV3EntityPolicy | undefined>;
}

export interface ReviewV3AssignmentRecord {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly task: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly entity: string;
  readonly role: ReviewV3Role;
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
  status: ReviewV3AssignmentStatus;
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

export interface ReviewV3StoredResult {
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
  readonly usage?: ReviewV3AdapterUsage;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ReviewV3CoverageRecord {
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

export interface ReviewV3RegisteredWave {
  readonly waveId: string;
  readonly planHash: string;
  readonly reviewRound: number;
  readonly registeredAt: string;
}

export interface ReviewV3PlanAssignmentBinding {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly entity: string;
  readonly role: ReviewV3Role;
  readonly scopeIds: readonly string[];
  readonly waveId?: string;
  readonly coverage: readonly { readonly scopeId: string; readonly aspect: string }[];
  readonly delegatedCoverage?: readonly { readonly scopeId: string; readonly aspect: string }[];
  readonly allowDynamicChildren?: boolean;
}

export interface ReviewV3RegisterPlanInput {
  readonly planHash: string;
  readonly planVersion: number;
  readonly revision: string;
  readonly waves: readonly Omit<ReviewV3RegisteredWave, "planHash" | "registeredAt">[];
  readonly assignments: readonly ReviewV3PlanAssignmentBinding[];
}

export interface ReviewV3RegisteredPlan {
  readonly planHash: string;
  readonly planVersion: number;
  readonly revision: string;
  readonly registeredAt: string;
  readonly waves: Readonly<Record<string, ReviewV3RegisteredWave>>;
  readonly assignments: Readonly<Record<string, ReviewV3PlanAssignmentBinding>>;
}

export interface ReviewV3RunState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly revision: string;
  readonly config: ReviewV3Config;
  status: ReviewV3RunStatus;
  readonly createdAt: string;
  updatedAt: string;
  controllerLease: { ownerId: string; fencingToken: string; expiresAt: string };
  usedLaunches: number;
  outsideWaveLaunches: number;
  usedActiveAgentTimeMs: number;
  reservedAgentTimeMs: number;
  readonly waveLaunches: Record<string, number>;
  readonly registeredWaves: Record<string, ReviewV3RegisteredWave>;
  activePlan: ReviewV3RegisteredPlan | null;
  highestReviewRound: number;
  readonly assignments: Record<string, ReviewV3AssignmentRecord>;
  readonly idempotency: Record<string, string>;
  readonly results: Record<string, ReviewV3StoredResult>;
  readonly coverage: Record<string, ReviewV3CoverageRecord>;
}

export type ReviewV3Admission =
  | { readonly ok: true; readonly dispatchId: string; readonly reused: boolean }
  | { readonly ok: false; readonly code: "authority_denied" | "run_closed" | "adapter_missing" | "adapter_unsupported" | "entity_denied" | "skill_denied" | "depth_limit" | "role_violation" | "launch_limit" | "wave_limit" | "general_limit" | "child_limit" | "time_limit" | "invalid_input"; readonly message: string };

/** Host-only controls; never part of model or CLI spawn payload schemas. */
export interface ReviewV3HostSpawnOptions {
  readonly modelRounds?: number;
  readonly budgetClass?: "ordinary" | "reserved";
}

export interface ReviewV3ControllerDependencies {
  readonly storageDir: string;
  readonly adapters: readonly ReviewV3Adapter[];
  readonly authority: ReviewV3Authority;
  readonly entityPolicies?: ReviewV3EntityPolicyResolver;
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

export interface ReviewV3CreateOptions extends ReviewV3ControllerDependencies {
  readonly ownerId: string;
  readonly runId: string;
  readonly revision: string;
  readonly config: ReviewV3Config;
}

export type ReviewV3OpenOptions = ReviewV3ControllerDependencies;
