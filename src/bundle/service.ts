// Flow 313 (W4 portability), T6 — public facade for `src/bundle/**`. T10's
// CLI adapter (`src/commands/bundle.ts`) imports the portable-bundle core
// only through this module.

export {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_CONTENT_KINDS,
  BUNDLE_SCOPES,
  BUNDLE_REFUSAL,
} from "./types";
export type {
  BundleScope,
  BundleContentKind,
  BundleManifest,
  BundleContentEntry,
  BundleProvenance,
  BundleCompat,
  BundleContentOrigin,
  BundleRefusal,
  BundleRefusalReason,
} from "./types";

export { sha256Hex } from "./checksum";

export { normalizeBundlePath, validateKindPath, targetFor, scopeRoot } from "./paths";
export type { PathCtx } from "./paths";

export { buildBundleArchive, openBundle } from "./archive";
export type { BundleSource } from "./archive";

export { parseManifest, serializeManifest } from "./manifest";

export { exportBundle, rewriteAgentOrigin } from "./export";
export type { ExportOptions, ExportResult, ExportOutcome, ExportSkipped } from "./export";

export { verifyBundle, verifyBundlePath } from "./verify";
export type { VerifyResult, VerifyEntryResult, VerifyEntryStatus, VerifyBundlePathResult } from "./verify";

export { readAppliedState, writeAppliedState, appliedStatePath } from "./applied-state";
export type { AppliedState, AppliedStateEntry } from "./applied-state";

export { planBundleImport } from "./plan";
export type { BundlePlan, PlanEntry, PlanBucket, PlanConflictReason, PlanBundleImportOptions } from "./plan";

export { auditBundlePlan } from "./audit";
export type { AuditBundlePlanOptions, AuditBundlePlanResult, RunAuditFn } from "./audit";

export { applyBundlePlan } from "./apply";
export type { ApplyBundlePlanOptions, ApplyBundlePlanResult } from "./apply";

export { inspectBundle } from "./inspect";
export type { InspectBundleOptions, InspectResult, InspectPlanEntry } from "./inspect";

export { uninstallBundle } from "./uninstall";
export type { UninstallBundleOptions, UninstallBundleResult, UninstallKept } from "./uninstall";
