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

/**
 * The bundled manifest's on-disk path, the same source/packaged two-candidate
 * lookup `install.ts` uses for the bundled skills/rules trees (works both
 * from source and from the packaged `dist/` tree — see `bundledRulesSourcePath`).
 */
export function bundledManifestPath(): string {
  const directPath = fileURLToPath(new URL("../bundled/install-manifest.json", import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  const packagedSourcePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "gdskills",
    "bundled",
    "install-manifest.json",
  );
  if (existsSync(packagedSourcePath)) {
    return packagedSourcePath;
  }

  return directPath;
}

/**
 * The keryx package root — the directory `module.paths` entries (e.g.
 * `src/gdskills/bundled/rules/core/git-rules.mdc`) resolve against. This is
 * NEVER the target project (`process.cwd()` for `keryx skills install`);
 * bundled source content ships inside the keryx package itself (`package.json`
 * `files`: `src/gdskills/bundled`), the same two-candidate dev/packaged
 * resolution every other `bundledXSourcePath` helper in this directory uses.
 */
export function defaultBundledSourceRoot(): string {
  const devCandidate = fileURLToPath(new URL("../../../", import.meta.url));
  if (existsSync(path.join(devCandidate, "src", "gdskills", "bundled"))) {
    return devCandidate;
  }
  // Packaged: this module's compiled location is <pkg>/dist/*.js, so the
  // package root is one directory up.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
