import type { Control, ProtocolResult } from "../remote-control/protocol";
import type { NativeSessionRuntime } from "./native-runtime";
import type { AppliedApprovalAnswer, SessionApprovalQuestion, SessionApprovalOutcome } from "./question-service";
import type { RunAgentTurnResult } from "../commands/agent";
import type { NormalizedUsage } from "../harness/provider/types";
import type { SessionProjectReadPort } from "./commands/effects";
import type { SessionRestriction } from "./commands/plan";
import type { SessionLifecyclePort, NativeForkHistorySeed } from "./host-lifecycle";

export interface NativeTurnIdentity {
  hostId: string;
  nativeSessionId: string;
  generation: number;
}
export interface NativeCheckObservation {
  taskId: string; command: string; status: "running" | "completed" | "failed" | "killed";
  exitCode?: number; startedAt: string; endedAt?: string;
  output?: string;
  outputTruncated?: boolean;
  source: "native-supervised-shell";
}
interface TurnObservationBase { sessionId: string; runId: string; turnId: string; observedAt: string; executor: NativeTurnIdentity }
export type NativeTurnObservation = TurnObservationBase & (
  | { kind: "admission-refused"; operationId: string; reason: "expired-work" | "temporarily-unavailable" | "renewal-drift" | "revoked-or-forbidden" | "stale-subject"; retainedQueue: boolean; selectionSettled: true; codingAdmitted: false }
  | { kind: "running"; snapshot: Control["ConfigSnapshot"] }
  | { kind: "progress"; text: string; toolName?: string }
  | { kind: "usage"; usage: NormalizedUsage; source?: "agent" | "routing-classifier"; candidateId?: string; providerId?: string; modelId?: string; actualProviderId?: string; actualModelId?: string }
  | { kind: "terminal"; outcome: "succeeded" | "failed" | "cancelled" | "unknown"; reason: string; result?: RunAgentTurnResult; checks: NativeCheckObservation[]; workspaceBaseline: string; partial: boolean }
);
export type NativeTurnObservationPayload = NativeTurnObservation extends infer Observation ? Observation extends NativeTurnObservation ? Omit<Observation, keyof TurnObservationBase> : never : never;
export interface ControllerAuthority { actorId: string; commandId: string; commandDigest: string }
export interface QueuedAdmissionAuthority extends ControllerAuthority {
  expectedSessionVersion: number;
  expectedConfigVersion: number;
  controller: Control["ControllerBinding"];
  expiresAt: string;
  runId?: string;
  turnId?: string;
  association?: Control["FlowAssociation"];
}
export interface SessionActionAuthority {
  session: Control["SessionRecord"];
  runId: string;
  turnId: string;
  kind: "model" | "tool";
  toolName?: string;
  signal?: AbortSignal;
}
export type SessionSelectionAuthorityResult = { status: "valid" | "temporarily-unavailable" | "revoked-or-forbidden" | "stale-subject" | "expired-work" | "unknown" };
export interface SessionSelectionAuthority {
  session: Control["SessionRecord"]; operationId: string; actorId: string; payloadDigest: string;
  /** The ORIGINAL literal request, including its original pins/hash; fresh delivery pins remain in session/target. */
  request: Control["StartTurnRequest"] | Control["MessageSubmit"] | Control["CommandInvoke"];
  runId: string; turnId: string; phase: "classifier-io" | "admission";
  candidateId?: string; providerId?: string; modelId?: string; signal: AbortSignal;
}
export interface SessionInspectionAuthority {
  session: Control["SessionRecord"];
  operationId: string;
  actorId: string;
  command: Control["CommandInvoke"];
  toolName: string;
  signal: AbortSignal;
}
export type SessionOwnedResource =
  | { kind: "task"; taskId: string; nativeSessionId: string; action: "kill" | "demote" }
  | { kind: "approval"; approvalId: string; runId: string; turnId: string; fingerprint: string; policyDigest: string; decision: "allow-once" | "deny" }
  | { kind: "question"; questionId: string; runId: string; turnId: string; fingerprint: string; policyDigest: string }
  | { kind: "turn"; runId: string; turnId: string; action: "interrupt" };
export interface SessionOwnedControlAuthority extends SessionInspectionAuthority { payloadDigest: string; resource: SessionOwnedResource }

export interface SessionWorkspacePort {
  /** Trusted held checkout ownership; never serialized to Hub. */
  rewind?: { ownership(): { nonce: string; gitHead: string; paths: string[] }; validatePaths(paths: readonly string[], signal: AbortSignal): Promise<void> };
  verify(expectedBaseline: string): Promise<ProtocolResult<{ baseline: string }> | { ok: true; baseline: string }>;
  checkpoint(): Promise<ProtocolResult<{ baseline: string }> | { ok: true; baseline: string }>;
  beforeEffect?: (toolName: string, input: Record<string, unknown>) => Promise<ProtocolResult<{ effectId: string }>>;
  afterEffect?: (effectId: string, result: { isError: boolean }) => Promise<ProtocolResult<{ baseline: string }>>;
}
export interface SessionHostOptions {
  cwd: string;
  dataDir?: string;
  /** Locally materialized native fork/resume identity, never taken from a remote body. */
  nativeSessionId?: string;
  initialRestriction?: SessionRestriction;
  initialHistory?: NativeForkHistorySeed;
  /** Per-Hub control records remain private; native dataDir is the shared shell history/lease namespace. */
  controlDir?: string;
  configDir?: string;
  record: Control["SessionRecord"];
  runtime: NativeSessionRuntime;
  workspace: SessionWorkspacePort;
  now?: () => number;
  /** Local machine bridge verifies the fresh Hub grant, immutable command context and receipt binding.
   * Absent means controller projection mutations are denied, never implicitly trusted. */
  authorizeController?: (receipt: Control["ControllerReceipt"], authority: ControllerAuthority) => Promise<boolean>;
  authorizeQueued?: (operationId: string, payloadDigest: string, authority: QueuedAdmissionAuthority) => Promise<boolean>;
  projectContext?: SessionProjectReadPort;
  inspectionMode?: "hub-remote" | "local-native";
  /** Current-role/control read for an already admitted live run. Never renews a start command. */
  authorizeAction?: (action: SessionActionAuthority) => Promise<boolean>;
  authorizeSelection?: (action: SessionSelectionAuthority) => Promise<boolean | SessionSelectionAuthorityResult>;
  authorizeInspection?: (action: SessionInspectionAuthority) => Promise<boolean>;
  authorizeOwnedControl?: (action: SessionOwnedControlAuthority) => Promise<boolean>;
  lifecycle?: SessionLifecyclePort;
}
interface OperationBase { operationId: string; payloadDigest: string; actorId: string; expiresAt?: string }
export type SessionHostOperation = OperationBase & (
  | { kind: "message"; request: Control["StartTurnRequest"]; runId: string; turnId: string }
  | { kind: "submit-message"; request: Control["MessageSubmit"] }
  | { kind: "command"; request: Control["CommandInvoke"]; runId?: string; turnId?: string; association?: Control["FlowAssociation"] }
  | { kind: "config"; request: Control["ConfigChange"] }
  | { kind: "confirm-command"; request: Control["CommandConfirmation"] }
  | { kind: "edit-queue"; request: Control["QueueEdit"] }
  | { kind: "remove-queue"; request: Control["QueueRemove"] }
  | { kind: "reauthorize-queue"; request: Control["QueueReauthorize"] }
  | { kind: "close-session"; request: Control["SessionClose"] }
  | { kind: "resume-session"; request: Control["SessionResume"] }
  | { kind: "cancel"; request: { expectedSessionVersion: number; controller: Control["ControllerBinding"] } }
);
export type SessionHostReceipt = Control["TurnReceipt"] | Control["CommandOutcome"] | Control["ConfigReceipt"] | Control["SessionOperationReceipt"];
/** Exact local owner recovery pins. Supplied only by the protected local owner channel, never by a Hub frame. */
export interface LocalOwnerRecoveryTarget {
  sessionId: string; nativeSessionId: string; controllerLeaseId: string; controllerVersion: number;
  expectedSessionVersion?: number; expectedHistoryVersion: number; expectedWorkspaceBaseline: string;
}
/** Measured closed snapshot followed by the actual released receipt; `recovery-required` means cessation stayed unproven. */
export type LocalOwnerRecoveryResult = ProtocolResult<{ stopped: true; session: Control["SessionRecord"]; controller: Control["ControllerReceipt"] }>;
export interface SessionPageQuery { cursor?: number; limit?: number }
export interface SessionHostPort {
  inspect(): Promise<Control["SessionRecord"]>;
  history(query?: SessionPageQuery): Promise<Control["HistoryPage"]>;
  events(query?: SessionPageQuery): Promise<Control["SessionEventPage"]>;
  catalogue(): Promise<Control["CommandCatalogue"]>;
  routingAvailability(): Promise<Control["RoutingAvailability"]>;
  queue(query?: SessionPageQuery): Promise<Control["QueuePage"]>;
  apply(operation: SessionHostOperation): Promise<SessionHostReceipt>;
  subscribe(afterCursor: number, sink: (event: Control["SessionEvent"]) => void): () => void;
  dispose(reason?: string): Promise<void>;
  /** Connection liveness is independent of session controller/native checkout ownership. */
  setConnected(connected: boolean): void;
  pendingApprovals(): { approvalId: string; runId: string; turnId: string; fingerprint: string; policyDigest: string }[];
  subscribeApprovalOutcome(sink: (outcome: SessionApprovalOutcome) => void): () => void;
  subscribeApprovals(sink: (question: SessionApprovalQuestion) => void): () => void;
  answerApproval(input: { approvalId: string; runId: string; turnId: string; actorId: string; request: Control["ApprovalAnswer"] }): Promise<AppliedApprovalAnswer>;
  cancel(input: { runId: string; turnId: string; actorId: string; request: Control["CancelRequest"] }): Promise<{ status: "stopped" | "unknown" | "too-late" | "rejected"; runId: string; turnId: string; reason: string }>;
  subscribeTurnOutcome(sink: (observation: NativeTurnObservation) => void): () => void;
  applyController(receipt: Control["ControllerReceipt"], authority: ControllerAuthority): Promise<ProtocolResult<Control["ControllerReceipt"]>>;
  /** Fresh command/grant delivery for unchanged queued input. Keeps original operation identity/digest. */
  admitQueued(operationId: string, payloadDigest: string, authority: QueuedAdmissionAuthority): Promise<SessionHostReceipt>;
  /** Local-only native identity for owner inspection; never serialized to Hub. */
  nativeSessionId(): string;
  /** Closes an exact expired idle owner only after actual owned runtime cessation, then releases its lapsed controller. Expiry selects the target; it never proves a stop. */
  recoverExpiredIdle(target: LocalOwnerRecoveryTarget): Promise<LocalOwnerRecoveryResult>;
}
