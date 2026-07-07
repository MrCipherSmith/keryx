import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists } from "../lib/fs";
import { validateWorkspace } from "./validate";
import { evaluateProfiles } from "./profiles";
import { extractCapabilities } from "./capabilities";
import type {
  CapabilitiesReport,
  MetaprojectManifest,
  ProfileEvaluation,
  ValidationResult,
} from "./types";

// Service facade for the `standard` command family. Handlers in
// src/commands/standard.ts stay thin and delegate here; these functions return
// structured results and never print.

export type DoctorReport = ValidationResult;

export async function runValidate(cwd: string): Promise<ValidationResult> {
  return validateWorkspace(cwd);
}

// Doctor is validation reframed as actionable fixes. The underlying result is
// identical; the command layer renders it with fix hints. Kept as a distinct
// entry point so the facade can diverge later (e.g. auto-fix suggestions).
export async function runDoctor(cwd: string): Promise<DoctorReport> {
  return validateWorkspace(cwd);
}

export type CapabilitiesResult = {
  report: CapabilitiesReport;
  profiles: ProfileEvaluation;
};

async function readManifest(cwd: string): Promise<MetaprojectManifest> {
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error(
      "Metaproject is not initialized (missing .metaproject/metaproject.json). Run `gd-metapro init` first.",
    );
  }
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .metaproject/metaproject.json: ${detail}`);
  }
}

export async function runCapabilities(cwd: string): Promise<CapabilitiesResult> {
  const manifest = await readManifest(cwd);
  return {
    report: extractCapabilities(manifest),
    profiles: await evaluateProfiles(cwd, manifest),
  };
}
