// Flow 309 (W1), T6: the install manifest — loads and validates
// `src/gdskills/bundled/install-manifest.json` against
// `docs/requirements/keryx-agent-platform-expansion/schemas/install-manifest.schema.json`
// (JSON Schema 2020-12, `$id: keryx://schemas/agent-platform/install-manifest.schema.json`).
//
// Schema loading mirrors `src/integrations/matrix.ts`'s pattern for
// `harness-capability-matrix.schema.json`: a static `with { type: "json" }`
// import straight from the docs path (no cross-file `$ref`s in this schema,
// so `SchemaResolver` never needs a real `schemaDir`), which `bun build`
// inlines at build time. No bundled copy of the schema is shipped — there is
// therefore nothing to pin byte-identical to the docs copy.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import installManifestSchemaJson from "../../../docs/requirements/keryx-agent-platform-expansion/schemas/install-manifest.schema.json" with {
  type: "json",
};
import { validateAgainstSchemaObject, type ValidationResult } from "../../contracts/validator";

export type HarnessId =
  | "claude"
  | "codex"
  | "cursor"
  | "windsurf"
  | "gemini-cli"
  | "kiro"
  | "github-copilot-agent"
  | "zed"
  | "antigravity"
  | "opencode"
  | "generic-mcp"
  | "keryx-shell";

/** Every id `$defs/harnessId` in install-manifest.schema.json enumerates, in the schema's own order — the runtime-checkable mirror of the `HarnessId` type, used to validate an arbitrary `--target`/`target` string before it is trusted anywhere (e.g. `planInstall`, `skillsInstallStatePath`). */
export const HARNESS_IDS: readonly HarnessId[] = [
  "claude",
  "codex",
  "cursor",
  "windsurf",
  "gemini-cli",
  "kiro",
  "github-copilot-agent",
  "zed",
  "antigravity",
  "opencode",
  "generic-mcp",
  "keryx-shell",
];

export type ModuleKind = "rule" | "skill" | "agent-ref" | "hook-runtime" | "schema" | "doc";
export type ModuleCost = "light" | "medium" | "heavy";
export type ModuleStability = "experimental" | "stable" | "deprecated";
export type ComponentFamily = "baseline" | "language" | "framework" | "capability" | "tool" | "agent" | "skill";
export type ProvenanceOrigin = "authored" | "generated" | "imported" | "learned";

export interface ManifestProvenance {
  origin: ProvenanceOrigin;
  sourceRef?: string;
  addedAt?: string;
}

export interface ManifestModule {
  kind: ModuleKind;
  description: string;
  paths: string[];
  targets: HarnessId[];
  dependencies?: string[];
  defaultInstall: boolean;
  cost: ModuleCost;
  stability: ModuleStability;
}

export interface ManifestComponent {
  family: ComponentFamily;
  modules: string[];
  detectionMarkers?: string[];
  provenance?: ManifestProvenance;
}

export interface ManifestProfile {
  description: string;
  modules: string[];
  components?: string[];
  stackDetectionAware?: boolean;
}

export interface InstallManifest {
  schemaVersion: "1.0.0";
  profiles: Record<string, ManifestProfile>;
  modules: Record<string, ManifestModule>;
  components: Record<string, ManifestComponent>;
}

/** The directory this module is loaded from: `<repo>/src/gdskills/manifest` from source, `<pkg>/dist` once bundled. */
function thisModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const BUNDLED_TREE = ["src", "gdskills", "bundled"] as const;

/**
 * The keryx package root — the directory `module.paths` entries (e.g.
 * `src/gdskills/bundled/rules/core/git-rules.mdc`) resolve against. This is
 * NEVER the target project (`process.cwd()` for `keryx skills install`);
 * bundled source content ships inside the keryx package itself (`package.json`
 * `files`: `src/gdskills/bundled`).
 *
 * Two layouts, told apart by where the bundled tree actually is:
 *   - packaged: the published entry is ONE flat bundle, `<pkg>/dist/cli.js`,
 *     so every module's directory is `<pkg>/dist` and the root is one up;
 *   - source: this file is `<repo>/src/gdskills/manifest/manifest.ts`, three up.
 * The packaged candidate is tried first because it cannot match by accident
 * from source (`src/gdskills/` holds no `src/gdskills/bundled`), whereas the
 * three-up candidate from `dist/` lands outside the package, in whatever
 * directory the package happens to be installed under.
 *
 * `moduleDir` is a parameter so the packaged layout can be exercised by a test
 * without building the package (flow 360, AC10).
 */
export function defaultBundledSourceRoot(moduleDir: string = thisModuleDir()): string {
  const packagedRoot = path.join(moduleDir, "..");
  if (existsSync(path.join(packagedRoot, ...BUNDLED_TREE))) {
    return packagedRoot;
  }
  const sourceRoot = path.join(moduleDir, "..", "..", "..");
  if (existsSync(path.join(sourceRoot, ...BUNDLED_TREE))) {
    return sourceRoot;
  }
  return packagedRoot;
}

/**
 * The bundled manifest's on-disk path: `src/gdskills/bundled/install-manifest.json`
 * under {@link defaultBundledSourceRoot}, in both layouts.
 *
 * It used to derive the path on its own, as `../bundled/…` and then
 * `../../src/gdskills/bundled/…` relative to this module. Both assume the
 * module sits two levels below the package's `src/`; from the flat published
 * `<pkg>/dist/cli.js` they resolve to `<pkg>/bundled/…` and to a path one level
 * ABOVE the package, so `keryx skills install --profile full --dry-run` failed
 * with ENOENT on a manifest that was shipped all along. (`bundledRulesSourcePath`
 * in `../install.ts` has the same shape but sits one directory higher, where
 * its `../src/…` fallback does reach the package root.)
 */
export function bundledManifestPath(moduleDir: string = thisModuleDir()): string {
  return path.join(defaultBundledSourceRoot(moduleDir), ...BUNDLED_TREE, "install-manifest.json");
}

/** Validate an arbitrary parsed document against `install-manifest.schema.json`. */
export function validateInstallManifest(data: unknown): ValidationResult {
  return validateAgainstSchemaObject(installManifestSchemaJson as unknown as Record<string, unknown>, data);
}

export class InvalidInstallManifestError extends Error {
  constructor(
    public readonly file: string,
    public readonly errors: ValidationResult["errors"],
  ) {
    super(
      `${file} fails install-manifest.schema.json validation: ${errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
    this.name = "InvalidInstallManifestError";
  }
}

/** Parse+validate a manifest document already read from disk (or authored in a test fixture). */
export function parseInstallManifest(fileLabel: string, raw: unknown): InstallManifest {
  const validation = validateInstallManifest(raw);
  if (!validation.valid) {
    throw new InvalidInstallManifestError(fileLabel, validation.errors);
  }
  return raw as InstallManifest;
}

/** Load and validate the bundled `install-manifest.json`. Throws {@link InvalidInstallManifestError} on drift. */
export function loadBundledManifest(): InstallManifest {
  const file = bundledManifestPath();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return parseInstallManifest(file, parsed);
}
