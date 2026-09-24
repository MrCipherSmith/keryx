// Flow 313 (W4 portability), T6 — portable bundle manifest types.
// Mirrors `docs/requirements/keryx-agent-platform-expansion/schemas/portable-bundle.schema.json`
// field-for-field. This module owns no I/O; it only declares the shapes the
// rest of `src/bundle/**` reads and writes.

export const BUNDLE_FORMAT_VERSION = "1.0.0";

export type BundleScope = "project" | "team" | "user";

export const BUNDLE_SCOPES: readonly BundleScope[] = ["project", "team", "user"];

export type BundleContentKind =
  | "skill"
  | "rule"
  | "agent"
  | "learned-pattern"
  | "memory-entry"
  | "hook-config";

export const BUNDLE_CONTENT_KINDS: readonly BundleContentKind[] = [
  "skill",
  "rule",
  "agent",
  "learned-pattern",
  "memory-entry",
  "hook-config",
];

export interface BundleProvenance {
  producedBy: "keryx bundle export";
  sourceProject?: string;
  sourceScope: BundleScope;
}

export interface BundleCompat {
  minKeryxVersion: string;
  targetHarnesses?: string[];
}

export interface BundleContentOrigin {
  external?: boolean;
  sourceRef?: string;
}

export interface BundleContentEntry {
  path: string;
  kind: BundleContentKind;
  scope: BundleScope;
  sha256: string;
  sizeBytes: number;
  description?: string;
  origin?: BundleContentOrigin;
}

export interface BundleManifest {
  formatVersion: string;
  bundleId: string;
  createdAt: string;
  sourceKeryxVersion: string;
  provenance: BundleProvenance;
  compat: BundleCompat;
  contents: BundleContentEntry[];
}

// Named refusal reasons. Every function in `src/bundle/**` fails closed with
// one of these rather than a generic Error, so a caller (T10's CLI adapter)
// can render a stable, testable reason string.
export const BUNDLE_REFUSAL = {
  checksumMismatch: "checksum-mismatch",
  sizeMismatch: "size-mismatch",
  missingEntry: "missing-entry",
  unlistedFile: "unlisted-file",
  schemaInvalid: "schema-invalid",
  unsupportedFormatVersion: "unsupported-format-version",
  pathEscape: "path-escape",
  pathNotValidForScope: "path-not-valid-for-scope",
  kindPathMismatch: "kind-path-mismatch",
  duplicatePath: "duplicate-path",
  symlinkRefused: "symlink-refused",
  contentInvalid: "content-invalid",
  learnedPatternScope: "learned-pattern-scope",
  userScopeRuleRefused: "user-scope-rule-refused",
  privateGitignoreConflict: "private-gitignore-conflict",
  auditFailed: "audit-failed",
  auditIncomplete: "audit-incomplete",
  unresolvedConflict: "unresolved-conflict",
  unknownForcePath: "unknown-force-path",
  notABundle: "not-a-bundle",
  archiveInvalid: "archive-invalid",
  archiveTooLarge: "archive-too-large",
  scopeMismatch: "scope-mismatch",
  hooksRequireOptIn: "hooks-require-opt-in",
  corruptLedger: "corrupt-ledger",
  applyFailed: "apply-failed",
  noMetaproject: "no-metaproject",
} as const;

export type BundleRefusalReason = (typeof BUNDLE_REFUSAL)[keyof typeof BUNDLE_REFUSAL];

export interface BundleRefusal {
  reason: BundleRefusalReason;
  path?: string;
  message: string;
}
