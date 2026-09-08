/** Narrow SAC implementation boundary for harness workspace tools. */
export { createLocalFwkReadService, normalizeFwkResult } from "./fwk-service";
export { proposalNotePath } from "./proposal-evidence";
export { createHarnessProposalLifecycleService, normalizeProposalLifecycleResult } from "./proposal-lifecycle";
export { sessionEvidenceRef } from "./session-wrap-up";
export { listWorkspaceViews, localWorkspaceAuthorizationServer, lookupWorkspace, newWorkspaceId, WorkspaceService } from "./workspace-service";
