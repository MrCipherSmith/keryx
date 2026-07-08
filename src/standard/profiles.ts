import path from "node:path";
import { pathExists } from "../lib/fs";
import { readFile } from "node:fs/promises";
import type { MetaprojectManifest, ProfileEvaluation, ProfileName } from "./types";
import { PROFILE_NAMES } from "./types";

// The version of the Metaproject Standard this reference implementation targets.
// Matches docs/requirements/metaproject-standard/*.md (Version: 0.1.0).
export const STANDARD_VERSION = "0.1.0";

// Modules that make a workspace agent-compatible (discovery/routing surface).
const AGENT_MODULES = ["gdgraph", "gdctx", "gdskills", "gdwiki", "memory"];

// Modules that publish normalized CI report artifacts.
const CI_MODULES = ["health", "testing"];

// Root agent entrypoints that must link `.metaproject/index.md`.
const ROOT_ENTRYPOINTS = ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"];

const INDEX_LINK = ".metaproject/index.md";

// Compute the profiles a freshly generated manifest should declare, from the
// set of enabled module keys. Used by both `init` and `update` manifest
// builders so the declared `profiles` array never drifts between them.
//
// Per profiles.md: `minimal` is always present once the required workspace
// exists; `agent` when agent-facing modules are enabled; `ci` when report
// modules are enabled; `full` when it satisfies minimal + agent + ci.
export function computeProfiles(enabledModuleKeys: string[]): string[] {
  const enabled = new Set(enabledModuleKeys);
  const hasAgent = AGENT_MODULES.some((key) => enabled.has(key));
  const hasCi = CI_MODULES.some((key) => enabled.has(key));

  const profiles: ProfileName[] = ["minimal"];
  if (hasAgent) {
    profiles.push("agent");
  }
  if (hasCi) {
    profiles.push("ci");
  }
  if (hasAgent && hasCi) {
    profiles.push("full");
  }
  return profiles;
}

function enabledModuleKeys(manifest: MetaprojectManifest): string[] {
  const modules = manifest.modules ?? {};
  return Object.entries(modules)
    .filter(([, entry]) => entry?.enabled === true)
    .map(([key]) => key);
}

async function rootEntrypointLinksIndex(cwd: string): Promise<boolean> {
  for (const name of ROOT_ENTRYPOINTS) {
    const filePath = path.join(cwd, name);
    if (!(await pathExists(filePath))) {
      continue;
    }
    const content = await readFile(filePath, "utf8");
    if (content.includes(INDEX_LINK)) {
      return true;
    }
  }
  return false;
}

async function minimalSatisfied(cwd: string): Promise<boolean> {
  const metaprojectRoot = path.join(cwd, ".metaproject");
  const requiredFiles = ["index.md", "README.md", "metaproject.json"];
  const requiredDirs = ["modules", "rules", "skills", "data"];
  for (const file of requiredFiles) {
    if (!(await pathExists(path.join(metaprojectRoot, file)))) {
      return false;
    }
  }
  for (const dir of requiredDirs) {
    if (!(await pathExists(path.join(metaprojectRoot, dir)))) {
      return false;
    }
  }
  return true;
}

async function ciSatisfied(cwd: string, manifest: MetaprojectManifest): Promise<boolean> {
  const enabled = new Set(enabledModuleKeys(manifest));
  const ciModules = CI_MODULES.filter((key) => enabled.has(key));
  if (ciModules.length === 0) {
    return false;
  }
  // Lifecycle policy keeps `latest.md`/`latest.json` transient (often gitignored),
  // so satisfaction requires the normalized `artifacts/` location to exist for at
  // least one enabled report module, not the generated files themselves.
  for (const key of ciModules) {
    if (await pathExists(path.join(cwd, ".metaproject", "data", key, "artifacts"))) {
      return true;
    }
  }
  return false;
}

// Evaluate which standard profiles the workspace on disk actually satisfies and
// compare that against what the manifest declares.
export async function evaluateProfiles(
  cwd: string,
  manifest: MetaprojectManifest,
): Promise<ProfileEvaluation> {
  const satisfied: ProfileName[] = [];

  const minimal = await minimalSatisfied(cwd);
  if (minimal) {
    satisfied.push("minimal");
  }

  // The `agent` profile requires an actual agent-capability module to be enabled
  // (gdgraph/gdctx/gdskills/gdwiki/memory) — not merely the always-created
  // `skills/project-rules` bookkeeping folder — plus the on-disk agent routing
  // surface (root entrypoint links the index, rules are indexed). This keeps
  // evaluation consistent with `computeProfiles`, which declares `agent` on the
  // same module signal.
  const hasAgentModule = AGENT_MODULES.some((key) =>
    new Set(enabledModuleKeys(manifest)).has(key),
  );
  const agent =
    minimal &&
    hasAgentModule &&
    (await rootEntrypointLinksIndex(cwd)) &&
    (await pathExists(path.join(cwd, ".metaproject", "rules")));
  if (agent) {
    satisfied.push("agent");
  }

  const ci = minimal && (await ciSatisfied(cwd, manifest));
  if (ci) {
    satisfied.push("ci");
  }

  if (minimal && agent && ci) {
    satisfied.push("full");
  }

  const declared = Array.isArray(manifest.profiles) ? manifest.profiles : [];
  const satisfiedSet = new Set<string>(satisfied);
  const declaredSet = new Set(declared);

  const unsatisfiedDeclared = declared.filter((profile) => !satisfiedSet.has(profile));
  const undeclaredSatisfied = satisfied.filter((profile) => !declaredSet.has(profile));

  return {
    satisfied,
    declared,
    unsatisfiedDeclared,
    undeclaredSatisfied,
  };
}

export { PROFILE_NAMES };
