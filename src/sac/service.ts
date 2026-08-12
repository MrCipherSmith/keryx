/**
 * Public Shared Agent Context service facade.
 *
 * Transports import this module rather than the FWK implementation so the
 * MCP boundary stays coupled to one stable SAC service surface. Local-only
 * actor composition remains inside the implementation; callers cannot supply
 * identity or roles through this facade.
 */
export {
  createLocalFwkReadService,
  normalizeFwkResult,
  type FwkReadResult,
} from "./fwk-service";
export {
  createLocalProposalLifecycleService,
  normalizeProposalLifecycleResult,
  type TargetWriteResult,
  type GuardedTargetWriter,
} from "./proposal-lifecycle";
export { createLocalCollaborationService, normalizeCollaborationResult, type CollaborationActivity } from "./collaboration-service";
export {
  buildPolicyCorpus,
  defaultPolicyExperimentConfig,
  evaluatePolicyExperiment,
  formatPolicyEvaluationReport,
  hashVerifiedTaskOutcome,
  resolvePolicyExperiment,
  rollbackPolicyExperiment,
  POLICY_EXPERIMENT_SANDBOX_PROFILE,
  type CandidateSelection,
  type PolicyCorpus,
  type PolicyCorpusManifest,
  type PolicyCorpusRow,
  type PolicyEvaluationReport,
  type PolicyExperimentBaseline,
  type PolicyExperimentCandidate,
  type PolicyExperimentConfig,
  type PolicyExperimentSandbox,
  type VerifiedTaskOutcome,
} from "./policy-experiment";
export {
  hashAccessReceipt,
  sealAccessReceipt,
  verifyAccessReceiptLedger,
  type AccessReceiptLedgerVerification,
  type IntegrityLinkedAccessReceipt,
} from "./receipt-integrity";
