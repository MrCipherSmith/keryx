// Shared types for the Metaproject Standard tooling (`gd-metapro standard`).
//
// These describe the discovery manifest surface the standard commands read and
// the structured results the service facade returns. They intentionally stay
// permissive (optional fields, index signatures) because they model on-disk
// data that may be partial, legacy, or non-compliant.

export type ProfileName = "minimal" | "agent" | "ci" | "full";

export const PROFILE_NAMES: ProfileName[] = ["minimal", "agent", "ci", "full"];

// A single validation/diagnostic finding. `fix` carries an actionable hint used
// by `standard doctor`.
export type Issue = {
  code: string;
  message: string;
  fix?: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
};

// One module entry inside `metaproject.json`. Path-like fields point at
// on-disk locations relative to the project root.
export type ModuleManifestEntry = {
  enabled?: boolean;
  version?: string;
  manifest?: string;
  core?: string;
  data?: string;
  skills?: string;
  projectSkills?: string;
  wiki?: string;
  memory?: string;
  commands?: string[];
  capabilities?: string[];
  [key: string]: unknown;
};

// The discovery manifest. Kept loose because validation reads potentially
// non-compliant manifests and must not crash on missing/extra fields.
export type MetaprojectManifest = {
  schemaVersion?: number;
  standardVersion?: string;
  name?: string;
  createdBy?: string;
  projectType?: string;
  languages?: string[];
  profiles?: string[];
  paths?: Record<string, string>;
  modules?: Record<string, ModuleManifestEntry>;
  capabilities?: string[];
  updatedAt?: string;
  [key: string]: unknown;
};

// Normalized capability view of a single module, derived from the manifest.
export type ModuleCapability = {
  key: string;
  enabled: boolean;
  commands: string[];
  capabilities: string[];
};

export type CapabilitiesReport = {
  standardVersion: string | null;
  profiles: string[];
  modules: ModuleCapability[];
};

// Profile evaluation: which profiles the workspace actually satisfies versus
// what the manifest declares.
export type ProfileEvaluation = {
  satisfied: ProfileName[];
  declared: string[];
  // Declared but not satisfied by the workspace (a correctness problem).
  unsatisfiedDeclared: string[];
  // Satisfied but not declared in the manifest (a documentation gap).
  undeclaredSatisfied: ProfileName[];
};
