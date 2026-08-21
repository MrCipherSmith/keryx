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
  createHarnessProposalLifecycleService,
  normalizeProposalLifecycleResult,
  type TargetWriteResult,
  type GuardedTargetWriter,
} from "./proposal-lifecycle";
export { sessionEvidenceRef } from "./session-wrap-up";
export { proposalNotePath } from "./proposal-evidence";
export { findSession } from "../session/store";
export { createLocalCollaborationService, normalizeCollaborationResult, type CollaborationActivity } from "./collaboration-service";
export {
  WorkspaceService,
  WorkspaceServiceError,
  localWorkspaceAuthorizationServer,
  newWorkspaceId,
  type WorkspaceManifest,
  type WorkspaceResource,
} from "./workspace-service";
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
// SLATE-22..26 (v3, flow 182 T3): the external-hand Slate storage/lifecycle
// facade for the new `slate.*` MCP tools — mirrors `findSession` above
// (also re-exported here from `../session/*`) so `src/mcp/tools.ts` never
// reaches into `src/session/` internals directly (M-3 import-boundary test).
export {
  closeExternalSlate,
  isExternalSlateStale,
  readExternalSlate,
  reclaimStaleExternalSlates,
  writeExternalSlate,
  type ExternalSlate,
  type ExternalSlateAnchors,
} from "../session/external-slate";
export { SLATE_SEED_KINDS, isSlateSeedKind, SEED_TEXT_MAX_LENGTH, type SlateSeed, type SlateSeedKind } from "../session/slate";
// SLATE-16 (flow 182 T5): `slate.open`'s no-`workspaceId` path calls this
// existing resolve-or-create procedure — re-exported here (not imported
// directly from `./workspace-resolve`) so `src/mcp/tools.ts` stays within
// the "service facades only" import boundary (M-3, `mcp/boundary.test.ts`),
// the same reasoning `findSession`/`closeExternalSlate` above already
// document.
export { resolveOrCreateWorkspace, type ResolveOrCreateInput, type ResolveOrCreateResult } from "./workspace-resolve";
// F-002 fix (flow 182 T7): `slate.writeSeed` (`src/mcp/tools.ts`) needs to
// redact Seed `text` before persistence, exactly like the sibling
// keryx-native `slate_write_seed` tool (`slate-tool.ts`) already does — but
// `src/mcp/` may only import service facades (M-3, `mcp/boundary.test.ts`),
// never `../security/redact` directly (that module is NOT on the boundary
// test's `ALLOWED_EXTERNAL` list; `../security/guard`, which IS allowed, is a
// different module — `guardOutput`/`redactRaw` for tool OUTPUT scrubbing, not
// Seed input text). Re-exported here for the same reason as everything else
// in this file: one stable facade `src/mcp/tools.ts` is allowed to reach
// through.
export { redactSensitiveText } from "../security/redact";
