// Public facade for `src/learning/` (W3 core, T5). Re-exports the pieces
// built so far; later tasks (T6 observe, T7 extract, T8 accept/reject, T9
// apply/reviewer-profile, T10 promote/graduate) add their own modules and
// extend this facade.
export type {
  ConfidenceLevel,
  EvidenceItem,
  EvidenceKind,
  EvidenceSourceType,
  ExtractorKind,
  Graduation,
  GraduationTarget,
  IndexEntry,
  LearnedPattern,
  LearningDomain,
  LearningIndex,
  LearningScope,
  LearningStatus,
  LearningTtl,
  ObservationEvent,
  ObservationEventName,
  ObservationProjectIdentity,
  ProjectIdentity,
  ProjectIdentityKind,
  Provenance,
  Redaction,
  ReviewerProfile,
} from "./types";

export {
  applyDecay,
  applyEvidence,
  confidenceLevelFor,
  CONTRADICT_RATE,
  DECAY_RATE,
  LEVEL_HIGH_MIN,
  LEVEL_MEDIUM_MIN,
  MAX_EVIDENCE_WEIGHT,
  REINFORCE_RATE,
  SEED_DETERMINISTIC,
  SEED_MODEL_BACKED,
} from "./confidence";

export { normalizeRemoteUrl, resolveProjectIdentity, type ResolveProjectIdentityDeps } from "./identity";

export {
  assertInsideLearningRoot,
  assertValidLearningId,
  candidatesDir,
  decisionsLogPath,
  graduationDir,
  learningDataDir,
  LEARNING_ID_PATTERN,
  LearningPathError,
  observationFilePath,
  observationsDir,
  projectLockPath,
  projectPatternPath,
  userDecisionsLogPath,
  userIndexPath,
  userLearningDir,
  userLockPath,
  userPatternPath,
  userPatternsDir,
} from "./paths";

export { confidenceLevelConsistent, validateLearnedPattern, validateObservationEvent, type ValidationResult } from "./schema";

export { detectInjectionShape, redactPreview, scanLearnedText, type ScanResult } from "./scan";

// --- T6: Observe -------------------------------------------------------------

export {
  appendObservation,
  buildObservationLine,
  createLearningObservationSink,
  mapHookEventToObservation,
  observeHostHookPayload,
  type AppendObservationDeps,
  type BuildObservationLineDeps,
  type BuildObservationLineInput,
  type CreateLearningObservationSinkDeps,
  type LearningObservationLike,
  type LearningObservationSink,
} from "./observe";

// `accept-capability.ts` is deliberately NOT re-exported here: the source
// audit (`accept-capability.test.ts`) asserts only `store.ts` and `accept.ts`
// (T8) import it, and re-exporting it from this facade would make every
// caller of this facade an importer too.

export {
  LearningStoreError,
  listPatterns,
  readIndex,
  readPattern,
  writeIndex,
  writePattern,
  type ListPatternsFilter,
  type StoreEnvOptions,
  type WritePatternOptions,
} from "./store";

export {
  appendDecision,
  auditAcceptedRecords,
  readDecisions,
  type AppendDecisionInput,
  type Decision,
  type DecisionAction,
  type DecisionLogOptions,
} from "./decisions";

// --- T7: Extract ------------------------------------------------------------

export {
  deterministicPatternId,
  loadObservationWindow,
  LearningExtractError,
  runExtract,
  type ExtractReport,
  type ModelExtractor,
  type RunExtractOptions,
} from "./extract";

export { learningConfigPath, loadLearningConfig, type LearningConfig } from "./config";

export { generalizeLesson, reviewerIdFor } from "./reviewer-id";

export type { ObservationLine, SignalDraft, SignalRunner, SignalRunOptions } from "./signals/types";

// --- T8: Accept / reject / prune --------------------------------------------

export {
  acceptPattern,
  LearningAcceptError,
  rejectPattern,
  type AcceptOptions,
  type AcceptResult,
  type RejectOptions,
  type RejectResult,
} from "./accept";

export { pruneLearning, type ExpiredRecord, type PruneOptions, type PruneReport } from "./prune";

// --- T9: Apply / reviewer profiles ------------------------------------------

export {
  applyLearnedPattern,
  learnedPatternToProposal,
  LearningApplyError,
  type ApplyLearnedPatternOptions,
  type ApplyLearnedPatternResult,
} from "./apply";

export {
  applyReviewerProfile,
  renderReviewerProfile,
  LearningReviewerProfileError,
  type ApplyReviewerProfileOptions,
  type ApplyReviewerProfileResult,
  type RenderReviewerProfileOptions,
} from "./reviewer-profile";

// --- T10 stub (final signature; body lands with that task) -----------------

export { promotePattern, LearningPromoteError, type PromotePatternOptions } from "./promote";

export {
  applyGraduation,
  runGraduate,
  LearningGraduateError,
  type ApplyGraduationOptions,
  type RunGraduateOptions,
} from "./graduate";
