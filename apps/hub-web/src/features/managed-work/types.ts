// Draft v0.1.1 work-domain projection. Isolated from machine-v2 contracts.
export type DocumentRef = {
  documentId: string;
  version: number;
  contentDigest: string;
};
export type Criterion = {
  criterionId: string;
  text: string;
  waivable: boolean;
};
export type Artifact =
  | {
      kind: "git";
      repositoryId: string;
      commitOid: string;
      treeOid: string | null;
      pullRequest: { number: number; observedHeadOid: string } | null;
      verification: "claimed" | "observed";
      observedAt: string | null;
    }
  | {
      kind: "document";
      reference: { documentId: string; version: number; contentDigest: string };
      proposalId: string | null;
    }
  | { kind: "legacy"; revisionId: string; treeDigest: string }
  | { kind: "report"; text: string; contentDigest: string };
export type Coverage = {
  criterionId: string;
  result: "pass" | "fail" | "inconclusive" | "missing";
  evidenceIds: string[];
}[];
export type FlowRevision = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "flow-revision";
  flowId: string;
  revision: number;
  problem: string;
  expectedOutcome: string;
  scope: string;
  outOfScope: string;
  specification: {
    documentId: string;
    version: number;
    contentDigest: string;
  } | null;
  criteria: { criterionId: string; text: string; waivable: boolean }[];
  requiredIntentIds: string[];
  contentDigest: string;
};
export type WorkFlow = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "flow";
  title: string;
  ownerId: string | null;
  version: number;
  state:
    | "draft"
    | "ready"
    | "in-progress"
    | "in-review"
    | "accepted"
    | "cancelled";
  currentRevisionId: string;
  approvedRevisionId: string | null;
  acceptanceDecisionId: string | null;
  legacyFlowId: string | null;
  updatedAt: string;
};
export type IntentRevision = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "intent-revision";
  intentId: string;
  revision: number;
  flowRevisionId: string;
  deliverable: string;
  approach: string;
  outOfScope: string;
  criteria: { criterionId: string; text: string; waivable: boolean }[];
  flowCriterionIds: string[];
  contentDigest: string;
  criterionMappings: { intentCriterionId: string; flowCriterionId: string }[];
};
export type WorkIntent = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "intent";
  flowId: string;
  title: string;
  ownerId: string | null;
  required: boolean;
  version: number;
  state:
    | "draft"
    | "ready"
    | "in-progress"
    | "in-review"
    | "accepted"
    | "cancelled";
  currentRevisionId: string;
  approvedRevisionId: string | null;
  selectedSubmissionId: string | null;
  acceptanceDecisionId: string | null;
  updatedAt: string;
};
export type ContextSnapshot = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "context";
  flowRevisionId: string;
  intentRevisionId: string;
  entries: {
    entryId: string;
    role: "spec" | "wiki" | "rule" | "skill" | "decision" | "local-overlay";
    reference: {
      documentId: string;
      version: number;
      contentDigest: string;
    } | null;
    required: boolean;
    resolution: "resolved" | "unavailable" | "unverified";
    contentDigest: string | null;
    provenance: "hub" | "contributor" | "runtime-observed";
  }[];
  gitBases: {
    repositoryId: string;
    commitOid: string;
    verification: "claimed" | "observed";
  }[];
  contentDigest: string;
};
export type Attempt = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "attempt";
  flowId: string;
  intentId: string;
  flowRevisionId: string;
  intentRevisionId: string;
  contextSnapshotId: string;
  participantId: string;
  method: "human" | "native-agent" | "external-agent";
  summary: string;
  supersedesAttemptId: string | null;
  version: number;
  state:
    | "draft"
    | "running"
    | "blocked"
    | "submitted"
    | "failed"
    | "cancelled"
    | "accepted"
    | "changes-requested"
    | "rejected"
    | "withdrawn";
  executionOutcome: "none" | "active" | "known-terminal" | "unknown";
  submissionId: string | null;
  updatedAt: string;
};
export type ExecutionLink = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "execution-link";
  attemptId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  machineId: string;
  checkoutId: string;
  associationDigest: string;
  contextObservation: "unverified" | "observed-match" | "observed-drift";
  observedContextDigest: string | null;
};
export type ResultSubject = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "subject";
  attemptId: string;
  artifacts: Artifact[];
  report: string;
  contentDigest: string;
};
export type EvidenceRecord = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "evidence";
  attemptId: string;
  subjectId: string;
  subjectDigest: string;
  criterionIds: string[];
  result: "pass" | "fail" | "inconclusive";
  source:
    | "contributor-report"
    | "machine-observation"
    | "ci-observation"
    | "human-review";
  method: string;
  report: string;
  outputDigest: string;
  sourceRunId: string | null;
  sourceObservationId: string | null;
  contentDigest: string;
};
export type ReviewSubmission = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "submission";
  attemptId: string;
  subjectId: string;
  subjectDigest: string;
  flowRevisionId: string;
  intentRevisionId: string;
  contextSnapshotId: string;
  evidenceIds: string[];
  coverage: Coverage;
  knowledgeFollowup: { proposalIds: string[]; noUpdateReason: string | null };
  contentDigest: string;
};
export type Decision = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "decision";
  targetType:
    | "flow-revision"
    | "intent-revision"
    | "amendment"
    | "attempt-selection"
    | "intent-review"
    | "flow-review"
    | "criterion-waiver";
  targetId: string;
  targetDigest: string;
  decision:
    | "approve"
    | "withdraw"
    | "select"
    | "accept"
    | "reject"
    | "request-changes"
    | "waive";
  reason: string;
  actorKind: "human";
  operationId: string;
  contentDigest: string;
};
export type FlowSubmission = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "flow-submission";
  flowId: string;
  flowRevisionId: string;
  acceptedIntents: {
    intentId: string;
    intentRevisionId: string;
    decisionId: string;
    submissionId: string;
    subjectDigest: string;
  }[];
  knowledgeProposalIds: string[];
  contentDigest: string;
  criterionCoverage: {
    flowCriterionId: string;
    intentId: string;
    intentCriterionId: string;
    submissionId: string;
    decisionId: string;
  }[];
};
export type AmendmentManifest = {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  kind: "amendment";
  flowId: string;
  sourceFlowRevisionId: string;
  affectedIntentIds: string[];
  replacements: {
    targetType: "flow" | "intent";
    targetId: string;
    revisionId: string;
    contentDigest: string;
  }[];
  reason: string;
  contentDigest: string;
};
export type WorkRecord =
  | FlowRevision
  | WorkFlow
  | IntentRevision
  | WorkIntent
  | ContextSnapshot
  | Attempt
  | ExecutionLink
  | ResultSubject
  | EvidenceRecord
  | ReviewSubmission
  | Decision
  | FlowSubmission
  | AmendmentManifest;
export type WorkCapabilities = {
  protocolVersion: 1;
  enabled: boolean;
  allowedCommands: string[];
  limits: Record<string, number>;
  features: {
    managedExecution: boolean;
    gitObserver: boolean;
    legacyConversion: boolean;
  };
};
export type WorkAction = {
  command: string;
  allowed: boolean;
  reasonCode: string | null;
};
export type WorkSnapshot = {
  records: WorkRecord[];
  actions: WorkAction[];
  eventCursor: string;
};
export type WorkCommand = {
  operationId: string;
  expectedVersions: Record<string, number>;
  command: string;
  payload: Record<string, unknown>;
};
export type WorkReceipt = {
  operationId: string;
  receiptId?: string;
  eventCursor?: string;
  entities?: WorkRecord[];
  status?: "pending" | "committed";
};
