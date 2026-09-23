// `src/governance/service.ts` — the governance owner's public facade.
//
// Every other core owner an adapter calls into publishes one
// (`src/health/service.ts`, `src/forgetting/service.ts`, …), and
// `src/lib/import-policy.ts` encodes the rule: a client or adapter imports a
// core owner only through its `service.ts`. Before this file existed,
// `src/commands/governance.ts` had no compliant way to reach `src/governance/`
// and `import-policy.live.test.ts`'s facade-less set grew by one — the guard
// reporting, correctly, that the rule had become unsatisfiable for a
// directory that had just been declared core. This file is the answer to
// that, not an exemption: it follows `src/forgetting/service.ts`'s precedent
// exactly (its own header describes the identical situation for `sync`).
//
// Deliberately NOT re-exported from `src/core.ts`: that entry publishes ten
// owner facades and `src/core-package.test.ts` pins the list exactly.
// Widening the published package's surface is a packaging decision belonging
// to that lane, and nothing outside this repository asks for it yet.

export {
  buildGovernanceReport,
  GOVERNANCE_SCHEMA_VERSION,
  governanceDataRoot,
  readLatestGovernanceReport,
  renderGovernanceMarkdown,
  writeGovernanceArtifacts,
  type BuildGovernanceReportOptions,
} from "./report";

export type {
  CriterionConfirmation,
  FlowConfirmations,
  FlowGateOutcomes,
  FlowGovernance,
  FlowReviewSpend,
  GovernanceFilters,
  GovernanceReport,
  GovernanceReportRead,
  PolicyDecisionsSummary,
  ProjectGovernance,
  ProjectTriggerSpend,
} from "./types";
