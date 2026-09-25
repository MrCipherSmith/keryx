import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { pathExists } from "../lib/fs";
import { readJsonFile, readJsonFileOr } from "../lib/json";
import { normalizeRouteText, routeTokens } from "../lib/route-tokens";
import {
  BUNDLED_GDSKILLS,
  getBundledSkillsForProfile,
  normalizeGdskillsProfile,
  renderGdskillsCatalog,
  type BundledSkill,
  type GdskillsProfile,
} from "../gdskills/catalog";
import {
  CONTRACTS,
  normalizeContractName,
  relativeContractPath,
  validateContractFile,
} from "../gdskills/contracts";
import { installGdskills } from "../gdskills/install";
import { skillsGovernanceCommand } from "./skills-governance";
import {
  applyInstall,
  defaultBundledSourceRoot,
  doctorInstall,
  loadBundledManifest,
  planInstall,
  uninstallInstall,
  HARNESS_IDS,
  SUPPORTED_TARGETS,
  type HarnessId,
  type InstallPlan,
} from "../gdskills/manifest";
import { banner, heading, note, style, symbols, nextSteps } from "../lib/ui";
import {
  applyLearningProposal,
  learnProjectSkill,
  type LearningSourceType,
} from "../gdskills/learn";
import {
  exportProjectSkill,
  normalizeSkillRuntime,
} from "../gdskills/export";
import {
  GLOBAL_SYNC_RUNTIMES,
  resolveGlobalSyncTarget,
  syncRuntimeSkills,
  syncRuntimeSkillsToGlobal,
} from "../gdskills/sync";
import {
  createProjectSkill,
  normalizeProjectSkillFormat,
  type ProjectSkillRegistryEntry,
} from "../gdskills/project-skills";
import { runSkillsImportCommand, runSkillsUpdateCommand } from "../gdskills/import-skills";
import { verifyProjectSkill } from "../gdskills/verify";
import {
  defaultBundledRoot,
  evaluateBundledTree,
  renderBundledEvaluation,
} from "../gdskills/bundled-eval";

type MetaprojectManifest = {
  modules?: {
    gdskills?: {
      enabled?: boolean;
      profile?: GdskillsProfile;
      skills?: string;
      catalog?: string;
      projectSkillRegistry?: ProjectSkillRegistryEntry[];
    };
  };
};

type GdskillsStatusSummary = {
  initialized: boolean;
  enabled: boolean;
  profile: GdskillsProfile;
  bundledSkillsInProfile: number;
  installedSkillsRoot: string | "missing";
  catalog: string | "missing";
  projectSkills: {
    registered: number;
    withoutVerificationReport: number;
  };
  verificationReports: {
    total: number;
    fresh: number;
    needsReview: number;
    stale: number;
    blocked: number;
    lastVerified: string | "never";
  };
  learningProposals: {
    total: number;
    pending: number;
    applied: number;
  };
};

export async function skillsCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printSkillsHelp();
    return;
  }

  if (command === "catalog") {
    const profile = normalizeGdskillsProfile(optionValue(args, "--profile"));
    console.log(renderGdskillsCatalog(profile));
    return;
  }

  if (command === "install") {
    await installSkillsCommand(args);
    return;
  }

  if (command === "doctor") {
    await doctorSkillsCommand(args);
    return;
  }

  if (command === "uninstall") {
    await uninstallSkillsCommand(args);
    return;
  }

  if (command === "status") {
    await printGdskillsStatus(args);
    return;
  }

  if (command === "list") {
    await listProjectSkills(args);
    return;
  }

  if (command === "inspect") {
    await inspectProjectSkill(args);
    return;
  }

  if (command === "route") {
    await routeProjectSkills(args);
    return;
  }

  if (command === "create" || command === "generate") {
    await createSkillCommand(args);
    return;
  }

  if (command === "import") {
    try {
      await runSkillsImportCommand(args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "update") {
    try {
      await runSkillsUpdateCommand(args);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === "verify") {
    await verifySkillCommand(args);
    return;
  }

  if (command === "learn") {
    await learnSkillCommand(args);
    return;
  }

  if (command === "export") {
    await exportSkillCommand(args);
    return;
  }

  if (command === "sync") {
    await syncSkillCommand(args);
    return;
  }

  if (command === "contracts") {
    await contractsCommand(args.slice(1));
    return;
  }

  // Flow 309, W1 Lane C governance gates — a separate dispatcher/module
  // (src/commands/skills-governance.ts) so this file's install/doctor/
  // uninstall branches (Lane B) and these three subcommands never touch the
  // same lines.
  if (command === "scout" || command === "eval" || command === "judge-check" || command === "stocktake") {
    await skillsGovernanceCommand(args);
    return;
  }

  console.error(`Unknown skills command: ${command}`);
  printSkillsHelp();
  process.exitCode = 1;
}

const LEGACY_INSTALL_PROFILES = new Set(["minimal", "recommended", "full", "custom"]);

/**
 * `keryx skills install` forks into two paths (flow 309, W1 Lane B):
 *   - the LEGACY path (unchanged): `installGdskills` writes the fixed curated
 *     subset for `minimal|recommended|full|custom`, exactly as before this
 *     flow.
 *   - the MANIFEST path (new): profile -> modules/components resolution via
 *     `src/gdskills/manifest`, used whenever any manifest-only flag is given
 *     (`--with`/`--without`/`--target`/`--dry-run`/`--json`/`--include-deprecated`)
 *     or the profile id is not one of the four legacy names (e.g. `core`,
 *     `react`, `nestjs`, `python` — or `minimal`/`full` WITH a manifest flag).
 * `--profile` with neither a value nor a manifest flag defaults to the legacy
 * `recommended` profile, matching the pre-existing behaviour exactly.
 */
/**
 * R2-8: a flag present on the command line but with no usable value — a
 * bare trailing token, one immediately followed by another flag
 * (`--target --json`), or an empty `--flag=` value — must be a hard CLI
 * error, not a silent fallback to the default (F3/F9/F13 fixed the same
 * class for `--strictness`/`--trials`/`--cwd` elsewhere; this is the
 * `install`/`doctor`/`uninstall` residual). Returns an error message, or
 * `undefined` when the flag is genuinely absent, or present with a
 * non-empty value. Exported for direct unit testing (skills-install-route.test.ts).
 */
export function valuelessFlagError(args: string[], name: string): string | undefined {
  const value = optionValue(args, name);
  if (value !== undefined && value.length > 0) return undefined;
  const givenWithoutUsableValue = value === "" || args.includes(name);
  return givenWithoutUsableValue ? `${name} requires a value.` : undefined;
}

/** Same as {@link valuelessFlagError}, for a repeatable flag such as `--with`/`--without` (see `collectRepeatedOption`). */
export function valuelessRepeatedFlagError(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return `${name} requires a value.`;
    } else if (arg === `${name}=`) {
      return `${name} requires a value.`;
    }
  }
  return undefined;
}

/**
 * F3: validate a raw `--target` string against the harness-id enum AND the
 * v1 destination table (`claude`, `keryx-shell`) before it reaches
 * `planInstall`/`doctorInstall`/`uninstallInstall` — those now refuse an
 * invalid target themselves too (defense in depth), but validating here
 * gives a clean, named CLI error instead of a plan/report full of internal
 * per-module errors, and keeps `doctor`/`uninstall` (which never call
 * `planInstall`) from reaching `skillsInstallStatePath` with an unvalidated
 * string at all. `undefined` (flag omitted) defaults to `"claude"`, matching
 * existing behaviour.
 */
function validateTargetArg(targetArg: string | undefined): HarnessId | { error: string } {
  if (targetArg === undefined) return "claude";
  if (!HARNESS_IDS.includes(targetArg as HarnessId)) {
    return { error: `Unknown --target "${targetArg}" (not a recognised harness id).` };
  }
  if (!SUPPORTED_TARGETS.includes(targetArg as HarnessId)) {
    return {
      error: `--target "${targetArg}" has no destination table in the v1 install-manifest yet (supported: ${SUPPORTED_TARGETS.join(", ")}).`,
    };
  }
  return targetArg as HarnessId;
}

/**
 * F18: which install path `keryx skills install` takes for this argv — LEGACY
 * (`installGdskillsLegacy`) or MANIFEST (`installFromManifest`). Extracted so
 * the SAME decision function drives both `installSkillsCommand` and its own
 * test, instead of two copies of the routing condition drifting apart.
 */
export function installRoute(profileArg: string | undefined, usesManifestFlags: boolean): "legacy" | "manifest" {
  const isLegacyProfileId = profileArg === undefined || LEGACY_INSTALL_PROFILES.has(profileArg);
  return !usesManifestFlags && isLegacyProfileId ? "legacy" : "manifest";
}

/**
 * F18: `--dry-run`/`--json` alone (no `--with`/`--without`/`--target`/
 * `--include-deprecated`) are the only manifest-only flags that can route a
 * LEGACY profile id (`minimal`/`full`/...) onto the manifest path while the
 * SAME profile id with no flags at all still runs the legacy installer —
 * `keryx skills install --profile minimal --dry-run` previews the
 * MANIFEST's own `minimal` profile, which is a different (and possibly
 * larger/smaller) file set than `keryx skills install --profile minimal`
 * (no `--dry-run`) actually installs. Rather than silently diverge, this
 * case prints a note naming exactly that. `--with`/`--without`/`--target`/
 * `--include-deprecated` are excluded here because those flags have no
 * legacy-installer equivalent at all — there is nothing for them to diverge
 * FROM, so no note is needed once one of them is present.
 */
export function installNeedsManifestPreviewNote(
  profileArg: string | undefined,
  opts: { withValues: string[]; withoutValues: string[]; targetArg: string | undefined; includeDeprecated: boolean },
): boolean {
  const isLegacyProfileId = profileArg === undefined || LEGACY_INSTALL_PROFILES.has(profileArg);
  return (
    isLegacyProfileId &&
    opts.withValues.length === 0 &&
    opts.withoutValues.length === 0 &&
    opts.targetArg === undefined &&
    !opts.includeDeprecated
  );
}

async function installSkillsCommand(args: string[]): Promise<void> {
  // R2-8: check every flag this command reads for a valueless occurrence
  // before any of it is used to decide legacy-vs-manifest routing — a
  // silently-defaulted `--target`/`--profile`/`--with`/`--without` must
  // never install a different, unintended plan.
  for (const error of [
    valuelessFlagError(args, "--profile"),
    valuelessFlagError(args, "--target"),
    valuelessRepeatedFlagError(args, "--with"),
    valuelessRepeatedFlagError(args, "--without"),
  ]) {
    if (error !== undefined) {
      console.error(error);
      process.exitCode = 1;
      return;
    }
  }

  const profileArg = optionValue(args, "--profile");
  const withValues = collectRepeatedOption(args, "--with");
  const withoutValues = collectRepeatedOption(args, "--without");
  const targetArg = optionValue(args, "--target");
  const includeDeprecated = args.includes("--include-deprecated");
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const force = args.includes("--force");

  const usesManifestFlags =
    withValues.length > 0 || withoutValues.length > 0 || targetArg !== undefined || includeDeprecated || dryRun || json;

  if (installRoute(profileArg, usesManifestFlags) === "legacy") {
    await installGdskillsLegacy(profileArg);
    return;
  }

  if (installNeedsManifestPreviewNote(profileArg, { withValues, withoutValues, targetArg, includeDeprecated })) {
    console.error(
      `Note: "--profile ${profileArg ?? "recommended"}" is a legacy profile id; ${dryRun ? "--dry-run" : "--json"} ` +
        `always resolves it through the manifest-driven installer instead, previewing THAT profile's plan. ` +
        `Running "keryx skills install --profile ${profileArg ?? "recommended"}" without --dry-run/--json installs ` +
        `the legacy curated subset, which may differ. Pass --with/--without/--target to use the manifest installer for real.`,
    );
  }

  const targetValidation = validateTargetArg(targetArg);
  if (typeof targetValidation !== "string") {
    console.error(targetValidation.error);
    process.exitCode = 1;
    return;
  }

  await installFromManifest({
    profileId: profileArg ?? "core",
    withValues,
    withoutValues,
    target: targetArg === undefined ? undefined : targetValidation,
    includeDeprecated,
    dryRun,
    json,
    force,
  });
}

/** The pre-flow-309 `keryx skills install --profile <p>` behaviour, unchanged. */
async function installGdskillsLegacy(profileArg: string | undefined): Promise<void> {
  const profile = normalizeGdskillsProfile(profileArg);
  const metaprojectRoot = path.join(process.cwd(), ".metaproject");
  banner("keryx skills install", `Profile: ${profile}`);
  if (!(await pathExists(metaprojectRoot))) {
    console.log(`  ${style.red(symbols.cross)} Metaproject is not initialized.`);
    console.log(`  ${style.cyan(symbols.arrow)} Run ${style.cyan("keryx init")} first.`);
    process.exitCode = 1;
    return;
  }

  const result = await installGdskills(metaprojectRoot, profile);
  console.log(
    `  ${style.green(symbols.ok)} Installed ${style.bold(String(result.installedSkills))} skills for profile ${style.bold(result.profile)}`,
  );
  heading("Locations");
  note(`skills   ${relativeToCwd(result.skillsRoot)}`);
  note(`catalog  ${relativeToCwd(result.catalogPath)}`);
  note(`manifest ${relativeToCwd(result.manifestPath)}`);
  // Notices first and under their own heading: they are work that succeeded
  // (files the sweep removed), and mixing them into "Warnings" buries the
  // entries that actually need the operator.
  if (result.notices.length > 0) {
    console.log("Notices:");
    for (const notice of result.notices) {
      console.log(`- ${notice}`);
    }
  }
  if (result.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }
  nextSteps([
    `Browse the catalog: ${style.cyan("keryx skills catalog")}.`,
    `Route a request: ${style.cyan("keryx skills route <target>")}.`,
  ]);
}

/** Every occurrence of `--flag value` / `--flag=value` in `args`, in order (unlike `optionValue`, which returns only the first). */
function collectRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === name) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) values.push(next);
      continue;
    }
    if (arg?.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    }
  }
  return values;
}

/**
 * Read `.metaproject/data/stack/stack.json` (lane A's `keryx stack detect`
 * output) directly, without importing lane A's in-progress module — this
 * command only needs the two fields `planInstall` consumes. Absence or a
 * parse failure both fail open: `planInstall` treats `stack: undefined` the
 * same way `src/review/stack.ts` treats an unreadable manifest (uncertain,
 * include everything).
 */
async function readStackDetectionForInstall(
  cwd: string,
): Promise<{ tags: Record<string, boolean>; uncertain: boolean } | undefined> {
  const file = path.join(cwd, ".metaproject", "data", "stack", "stack.json");
  if (!(await pathExists(file))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const tagsRaw = parsed.tags;
    const tags: Record<string, boolean> = {};
    if (tagsRaw && typeof tagsRaw === "object" && !Array.isArray(tagsRaw)) {
      for (const [key, value] of Object.entries(tagsRaw as Record<string, unknown>)) {
        if (typeof value === "boolean") tags[key] = value;
      }
    }
    return { tags, uncertain: parsed.uncertain === true };
  } catch {
    return undefined;
  }
}

function printInstallPlanHuman(plan: InstallPlan): void {
  banner("keryx skills install", `Profile: ${plan.profile} · Target: ${plan.target}`);
  if (plan.components.length > 0) {
    heading("Components");
    for (const component of plan.components) {
      const icon = component.included ? style.green(symbols.ok) : style.red(symbols.cross);
      note(`${icon} ${component.id} — ${component.reason}`);
    }
  }
  heading("Modules");
  if (plan.modules.length === 0) {
    note("(none resolved)");
  }
  for (const module of plan.modules) {
    note(`${module.id} (${module.kind}, ${module.files.length} file(s), cost ${module.cost}, ${module.stability})`);
  }
  if (plan.errors.length > 0) {
    console.log("Errors:");
    for (const error of plan.errors) {
      console.log(`- ${error}`);
    }
  }
}

async function installFromManifest(opts: {
  profileId: string;
  withValues: string[];
  withoutValues: string[];
  target: HarnessId | undefined;
  includeDeprecated: boolean;
  dryRun: boolean;
  json: boolean;
  force: boolean;
}): Promise<void> {
  const projectRoot = process.cwd();
  const sourceRoot = defaultBundledSourceRoot();
  const manifest = loadBundledManifest();
  const stack = await readStackDetectionForInstall(projectRoot);

  const plan = await planInstall({
    manifest,
    profileId: opts.profileId,
    with: opts.withValues,
    without: opts.withoutValues,
    target: opts.target,
    stack,
    includeDeprecated: opts.includeDeprecated,
    repoRoot: sourceRoot,
  });

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      printInstallPlanHuman(plan);
      if (plan.ok) {
        nextSteps([
          `Apply this plan: ${style.cyan(`keryx skills install --profile ${plan.profile} --target ${plan.target}`)}`,
        ]);
      }
    }
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  if (!plan.ok) {
    if (opts.json) {
      console.log(JSON.stringify({ plan }, null, 2));
    } else {
      printInstallPlanHuman(plan);
    }
    process.exitCode = 1;
    return;
  }

  const result = await applyInstall(plan, projectRoot, { force: opts.force, sourceRoot });

  if (opts.json) {
    console.log(JSON.stringify({ plan, result }, null, 2));
  } else {
    printInstallPlanHuman(plan);
    console.log(`  ${style.green(symbols.ok)} Wrote ${result.written.length} file(s) for target "${plan.target}".`);
    if (result.skipped.length > 0) {
      console.log("Skipped (existing file not recorded in install-state, or drifted — rerun with --force to overwrite):");
      for (const skipped of result.skipped) {
        console.log(`- ${skipped.path}: ${skipped.reason}`);
      }
    }
    if (result.errors.length > 0) {
      console.log("Errors:");
      for (const error of result.errors) {
        console.log(`- ${error}`);
      }
    }
  }
  if (!result.ok) process.exitCode = 1;
}

async function doctorSkillsCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printDoctorHelp();
    return;
  }
  const targetFlagError = valuelessFlagError(args, "--target");
  if (targetFlagError !== undefined) {
    console.error(targetFlagError);
    process.exitCode = 1;
    return;
  }
  const targetArg = optionValue(args, "--target");
  const json = args.includes("--json");
  const targetValidation = validateTargetArg(targetArg);
  if (typeof targetValidation !== "string") {
    console.error(targetValidation.error);
    process.exitCode = 1;
    return;
  }
  const target = targetValidation;
  const report = await doctorInstall(process.cwd(), target);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    banner("keryx skills doctor", `Target: ${target}`);
    if (report.invalidState.length > 0) {
      console.log("Invalid install-state (refusing to trust it):");
      for (const reason of report.invalidState) {
        console.log(`- ${reason}`);
      }
    } else if (report.entries.length === 0) {
      note("Nothing recorded for this target.");
    }
    for (const entry of report.entries) {
      const icon = entry.status === "ok" ? style.green(symbols.ok) : style.red(symbols.cross);
      const moduleLabel = entry.moduleId !== undefined ? ` (${entry.moduleId})` : "";
      note(`${icon} [${entry.status}] ${entry.path}${moduleLabel}`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

async function uninstallSkillsCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printUninstallHelp();
    return;
  }
  for (const error of [valuelessFlagError(args, "--target"), valuelessFlagError(args, "--module")]) {
    if (error !== undefined) {
      console.error(error);
      process.exitCode = 1;
      return;
    }
  }
  const targetArg = optionValue(args, "--target");
  const moduleId = optionValue(args, "--module");
  const force = args.includes("--force");
  const json = args.includes("--json");
  const targetValidation = validateTargetArg(targetArg);
  if (typeof targetValidation !== "string") {
    console.error(targetValidation.error);
    process.exitCode = 1;
    return;
  }
  const target = targetValidation;

  const result = await uninstallInstall(process.cwd(), target, { moduleId, force });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    banner("keryx skills uninstall", `Target: ${target}${moduleId !== undefined ? ` · Module: ${moduleId}` : ""}`);
    if (result.error !== undefined) {
      console.log(`  ${style.red(symbols.cross)} ${result.error}`);
    }
    console.log(`  ${style.green(symbols.ok)} Removed ${result.removed.length} file(s).`);
    if (result.diffs.length > 0) {
      console.log("Force-removed drifted files:");
      for (const diff of result.diffs) {
        console.log(`- ${diff.path}: ${diff.message}`);
      }
    }
    if (result.refused.length > 0) {
      console.log("Refused (drifted — rerun with --force):");
      for (const refusal of result.refused) {
        console.log(`- ${refusal.path}: ${refusal.reason}`);
      }
    }
  }
  if (!result.ok) process.exitCode = 1;
}

async function listProjectSkills(args: string[]): Promise<void> {
  const registry = await readProjectSkillRegistryFromManifest();
  if (args.includes("--json")) {
    console.log(JSON.stringify(registry, null, 2));
    return;
  }

  if (registry.length === 0) {
    console.log("No project skills registered.");
    return;
  }

  console.log("| Module | Skill | Target | Path |");
  console.log("|---|---|---|---|");
  for (const entry of registry) {
    console.log(`| ${entry.module} | ${entry.name} | ${entry.target} | ${entry.path} |`);
  }
}

async function inspectProjectSkill(args: string[]): Promise<void> {
  const target = args[1];
  if (!target || target === "--help" || target === "-h") {
    printInspectHelp();
    if (!target) {
      process.exitCode = 1;
    }
    return;
  }

  const registry = await readProjectSkillRegistryFromManifest();
  const entry = resolveProjectSkillRegistryEntry(registry, target);
  if (!entry) {
    console.error(`Project skill not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  const skillRoot = path.resolve(process.cwd(), entry.path);
  const skillMdPath = path.join(skillRoot, "SKILL.md");
  const verificationPath = path.join(skillRoot, "verification.md");
  const changelogPath = path.join(skillRoot, "skill-changelog.md");
  const reportPath = path.join(
    process.cwd(),
    ".metaproject",
    "data",
    "gdskills",
    "reports",
    `${entry.module}-${entry.name}-verification.json`,
  );
  const metadata = (await pathExists(skillMdPath))
    ? parseProjectSkillMetadata(await readFile(skillMdPath, "utf8"))
    : {};
  const inspection = {
    module: entry.module,
    name: entry.name,
    target: entry.target,
    path: entry.path,
    version: metadata.version ?? entry.version,
    status: metadata.status ?? entry.status,
    lastVerified: metadata.lastVerified ?? "never",
    files: {
      skill: (await pathExists(skillMdPath)) ? relativeToCwd(skillMdPath) : "missing",
      verification: (await pathExists(verificationPath)) ? relativeToCwd(verificationPath) : "missing",
      changelog: (await pathExists(changelogPath)) ? relativeToCwd(changelogPath) : "missing",
      latestReport: (await pathExists(reportPath)) ? relativeToCwd(reportPath) : "missing",
    },
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }

  console.log(`Project skill: ${inspection.module}/${inspection.name}`);
  console.log(`Target: ${inspection.target}`);
  console.log(`Path: ${inspection.path}`);
  console.log(`Version: ${inspection.version}`);
  console.log(`Status: ${inspection.status}`);
  console.log(`Last verified: ${inspection.lastVerified}`);
  console.log("Files:");
  console.log(`- SKILL.md: ${inspection.files.skill}`);
  console.log(`- verification.md: ${inspection.files.verification}`);
  console.log(`- skill-changelog.md: ${inspection.files.changelog}`);
  console.log(`- latest report: ${inspection.files.latestReport}`);
}

async function readProjectSkillRegistryFromManifest(): Promise<ProjectSkillRegistryEntry[]> {
  const manifestPath = path.join(process.cwd(), ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return [];
  }

  const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
  return manifest.modules?.gdskills?.projectSkillRegistry ?? [];
}

function resolveProjectSkillRegistryEntry(
  registry: ProjectSkillRegistryEntry[],
  input: string,
): ProjectSkillRegistryEntry | undefined {
  const normalized = input.replace(/\/SKILL\.md$/i, "");
  return registry.find((entry) => {
    const key = `${entry.module}/${entry.name}`;
    return (
      key === normalized ||
      entry.name === normalized ||
      entry.path === normalized ||
      entry.path.replace(/\/SKILL\.md$/i, "") === normalized ||
      entry.target === input
    );
  });
}

function parseProjectSkillMetadata(content: string): {
  version?: string | undefined;
  status?: string | undefined;
  lastVerified?: string | undefined;
} {
  return {
    version: content.match(/^Version:\s*(.+)$/m)?.[1]?.trim(),
    status: content.match(/^Status:\s*(.+)$/m)?.[1]?.trim(),
    lastVerified: content.match(/^Last Verified:\s*(.+)$/m)?.[1]?.trim(),
  };
}

async function routeProjectSkills(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printRouteHelp();
    return;
  }

  const query = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim();
  if (!query) {
    printRouteHelp();
    process.exitCode = 1;
    return;
  }

  // Bundled catalog skills (planning/orchestration/review/…): what an agent
  // should load for a natural-language intent like "prepare a docs package".
  const catalogMatches = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .map((match) => ({
      source: "catalog" as const,
      module: match.entry.category,
      name: match.entry.name,
      target: "-",
      path: `.metaproject/skills/gdskills/${match.entry.category}/${match.entry.name}/SKILL.md`,
      score: match.score,
      reasons: match.reasons,
      next: `Load .metaproject/skills/gdskills/${match.entry.category}/${match.entry.name}/SKILL.md`,
    }));

  // Project-skills: per-module skills auto-created for concrete code targets.
  const registry = await readProjectSkillRegistryFromManifest();
  const projectMatches = registry
    .map((entry) => scoreProjectSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .map((match) => ({
      source: "project" as const,
      module: match.entry.module,
      name: match.entry.name,
      target: match.entry.target,
      path: match.entry.path,
      score: match.score,
      reasons: match.reasons,
      next: `keryx skills inspect ${match.entry.module}/${match.entry.name}`,
    }));

  const matches = [...catalogMatches, ...projectMatches].sort(
    (a, b) =>
      b.score - a.score ||
      a.source.localeCompare(b.source) ||
      `${a.module}/${a.name}`.localeCompare(`${b.module}/${b.name}`),
  );

  const result = { query, matches };

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (matches.length === 0) {
    console.log(`No skills matched: ${query}`);
    console.log("Next: read .metaproject/skills/catalog.md, or keryx skills create <target> --module <module> --name <skill-name>");
    return;
  }

  console.log(`Skill route for: ${query}`);
  console.log("| Score | Source | Skill | Where | Reasons |");
  console.log("|---:|---|---|---|---|");
  for (const match of matches.slice(0, 10)) {
    const where = match.source === "catalog" ? `${match.module}/` : match.target;
    console.log(`| ${match.score} | ${match.source} | ${match.name} | ${where} | ${match.reasons.join(", ")} |`);
  }
  console.log(`Next: ${matches[0]?.next}`);
}

/**
 * Inflections a query word may add to a trigger word and still mean it.
 *
 * `-ment` is deliberately absent, and the pair that decides it is
 * "deployment"/"commitment": both are a six-letter stem plus `ment`, and one is
 * the skill while the other is not a routing request at all. No structural rule
 * separates them, so the ambiguous suffix is refused and "run the deployment"
 * is carried by an explicit trigger instead. Guessing would trade a false
 * negative anyone can see for a false positive nobody does.
 */
const INFLECTIONS = ["s", "es", "ed", "d", "ing", "er", "ers", "ion", "ions", "ation"];

/** The shortest stem an inflection may attach to, so "pr"/"prs" cannot match. */
const MIN_STEM = 4;

/**
 * True when `phrase` appears in `text` as whole words, allowing the LAST word an
 * inflected ending.
 *
 * A bare `includes` matched inside longer words: "commitment issues" scored the
 * `commit` skill and "preview the deck" reached review-orchestrator. Anchoring
 * on word boundaries alone fixes those and silently costs the true positives
 * with them — "run the deployment", "brainstorming ideas", "interviewing me
 * first" all stop matching. An earlier attempt made exactly that trade without
 * noticing, across 29 one-word triggers. Allowing an inflected tail on the last
 * word keeps both halves.
 */
function containsPhrase(text: string, phrase: string): boolean {
  const words = text.split(" ").filter(Boolean);
  const target = phrase.split(" ").filter(Boolean);
  if (target.length === 0) return false;
  for (let i = 0; i + target.length <= words.length; i += 1) {
    let matched = true;
    for (let j = 0; j < target.length; j += 1) {
      const word = words[i + j]!;
      const want = target[j]!;
      const last = j === target.length - 1;
      if (word === want) continue;
      if (last && matchesInflected(word, want)) continue;
      matched = false;
      break;
    }
    if (matched) return true;
  }
  return false;
}

function matchesInflected(word: string, stem: string): boolean {
  if (stem.length < MIN_STEM || !word.startsWith(stem)) return false;
  return INFLECTIONS.includes(word.slice(stem.length));
}

/**
 * Whether `trigger` fires for this query.
 *
 * Two paths, and the second one carries a repair. Verbatim inclusion is
 * unchanged. The order-free path matches the trigger's MEANINGFUL tokens against
 * the query's, which is what lets "requirements package" match "prepare
 * requirements documentation package" — but `routeTokens` drops words under
 * three characters, so a trigger could arrive at that test shorter than its
 * author wrote it. "ui review" reduced to ["review"], and `every()` over a
 * one-element list is satisfied by ANY query containing "review": the specialist
 * claimed a full trigger hit on every review request in every language and
 * outscored review-orchestrator, whose contract is to take the request that
 * names no specialist.
 *
 * The repair is to require the dropped words too, against the query's RAW words
 * rather than its filtered tokens — which is where a short word like "ui", "db"
 * or "pr" still exists. The trigger keeps exactly the specificity its author
 * gave it, and nothing is filtered on one side only. An earlier attempt instead
 * DENIED the order-free path to any trigger that had lost a word, which took the
 * count of triggers with no order-free path from 11 to 17 and cost 29 one-word
 * triggers their inflected matching.
 */
function triggerFires(
  trigger: string,
  normalizedQuery: string,
  queryWords: ReadonlySet<string>,
  queryTokens: ReadonlySet<string>,
): boolean {
  if (containsPhrase(normalizedQuery, trigger)) {
    return true;
  }
  const rawWords = trigger.split(" ").filter(Boolean);
  if (rawWords.length === 0) {
    return false;
  }
  const meaningful = routeTokens(trigger);
  return rawWords.every((word) =>
    meaningful.has(word) ? queryTokens.has(word) : queryWords.has(word),
  );
}

export function scoreBundledSkillRoute(
  entry: BundledSkill,
  query: string,
): { entry: BundledSkill; score: number; reasons: string[] } {
  const normalizedQuery = normalizeRouteText(query);
  if (!normalizedQuery) {
    return { entry, score: 0, reasons: [] };
  }

  const name = normalizeRouteText(entry.name);
  const triggers = entry.triggers.map((trigger) => normalizeRouteText(trigger)).filter(Boolean);
  const haystack = normalizeRouteText(
    [
      entry.name,
      entry.category,
      entry.description,
      entry.purpose,
      entry.triggers.join(" "),
      entry.workflow.join(" "),
    ].join(" "),
  );

  const queryTokens = routeTokens(normalizedQuery, true);

  let score = 0;
  const reasons: string[] = [];

  if (normalizedQuery === name) {
    score += 100;
    reasons.push("exact skill");
  }
  // A trigger fires when the query contains it verbatim, or when every
  // meaningful token of the trigger is present in the query (order-free) — so
  // "requirements package" still matches "prepare requirements documentation
  // package". Triggers carry both EN and RU phrasings.
  const queryWords = new Set(normalizedQuery.split(" ").filter(Boolean));
  const triggerHit = triggers.some((trigger) => triggerFires(trigger, normalizedQuery, queryWords, queryTokens));
  if (triggerHit) {
    score += 55;
    reasons.push("trigger");
  }
  // Word-anchored for the same reason the trigger test is: a bare `includes`
  // scored the `commit` skill for "commitment issues" and `pr` for "preview the
  // deck". Fixing the trigger test and leaving this one is how a fix repairs the
  // site a finding named and leaves its sibling.
  if (name && containsPhrase(normalizedQuery, name)) {
    score += 30;
    reasons.push("skill name");
  }

  const haystackTokens = routeTokens(haystack);
  const overlap = [...queryTokens].filter((token) => haystackTokens.has(token));
  if (overlap.length > 0) {
    score += overlap.length * 10;
    reasons.push(`tokens:${overlap.slice(0, 4).join("+")}`);
  }

  return { entry, score, reasons: [...new Set(reasons)] };
}

function scoreProjectSkillRoute(
  entry: ProjectSkillRegistryEntry,
  query: string,
): { entry: ProjectSkillRegistryEntry; score: number; reasons: string[] } {
  const normalizedQuery = normalizeRouteText(query);
  if (!normalizedQuery) {
    // Guard the `.includes("")` trap: an empty query used to match every entry.
    return { entry, score: 0, reasons: [] };
  }
  const key = `${entry.module}/${entry.name}`;
  const targetBase = path.basename(entry.target).replace(/\.[^.]+$/, "");
  const fields = {
    key: normalizeRouteText(key),
    module: normalizeRouteText(entry.module),
    name: normalizeRouteText(entry.name),
    target: normalizeRouteText(entry.target),
    targetBase: normalizeRouteText(targetBase),
    path: normalizeRouteText(entry.path),
  };
  let score = 0;
  const reasons: string[] = [];

  if (normalizedQuery === fields.key || normalizedQuery === fields.name) {
    score += 100;
    reasons.push("exact skill");
  }
  if (fields.target.includes(normalizedQuery) || normalizedQuery.includes(fields.target)) {
    score += 80;
    reasons.push("target");
  }
  if (fields.path.includes(normalizedQuery) || normalizedQuery.includes(fields.path)) {
    score += 70;
    reasons.push("path");
  }
  if (fields.targetBase && normalizedQuery.includes(fields.targetBase)) {
    score += 60;
    reasons.push("target basename");
  }
  if (fields.module && normalizedQuery.includes(fields.module)) {
    score += 30;
    reasons.push("module");
  }
  if (fields.name && normalizedQuery.includes(fields.name)) {
    score += 30;
    reasons.push("skill name");
  }

  const queryTokens = routeTokens(normalizedQuery, true);
  const candidateTokens = routeTokens(`${fields.key} ${fields.target} ${fields.path}`);
  const overlap = [...queryTokens].filter((token) => candidateTokens.has(token));
  if (overlap.length > 0) {
    score += overlap.length * 10;
    reasons.push(`tokens:${overlap.join("+")}`);
  }

  return { entry, score, reasons: [...new Set(reasons)] };
}

/**
 * Exposed so the synonym table can be asserted as a CLOSED contract.
 *
 * Tested only through end-to-end routing, the table's failure mode is invisible
 * in one direction: a prefix mapped to an ADDITIONAL wrong token changes nothing
 * a positive corpus pair can see. That is the exact defect that started this
 * work — `провер` expanded to check+verify+REVIEW and every check request
 * reached a review skill.
 */
export function expandQueryTokens(normalized: string): ReadonlySet<string> {
  return routeTokens(normalized, true);
}

// `normalizeRouteText` and `routeTokens` themselves live in
// `../lib/route-tokens` (flow 257 T18), not here. They used to be defined in
// this file and imported by `../gdskills/bundled-eval.ts`'s
// `description:collision` check — a CORE owner importing an ADAPTER module,
// which `import-policy.live.test.ts` enforces at zero tolerance with no
// exception. Moving both to `src/lib/` (the "shared" zone: see
// `../lib/import-zones.ts`) puts them on a target neither side's import is
// flagged for, rather than growing that allowlist for an unrelated file.
// Re-exported here — not restated — so this remains the ONE tokenizer
// `routing-baseline.test.ts`'s "no second copy of the ranking exists" guard
// protects, and every existing caller that imports these two names from
// `./skills` keeps working unchanged.
export { normalizeRouteText, routeTokens };

async function syncSkillCommand(args: string[]): Promise<void> {
  const runtime = normalizeSkillRuntime(optionValue(args, "--runtime"));
  const target = optionValue(args, "--target");
  // Writing into ~/.cursor/ and ~/.config/zed/ reaches outside the project, so
  // it is opt-in by an explicit flag and never a side effect of any other
  // command.
  const global = args.includes("--global");
  if (args.includes("--help") || args.includes("-h")) {
    printSyncHelp();
    return;
  }

  if (!runtime || (!target && !global)) {
    printSyncHelp();
    process.exitCode = 1;
    return;
  }

  if (global && target) {
    console.error("Use either --global or --target <dir>, not both.");
    process.exitCode = 1;
    return;
  }

  try {
    const result = global
      ? await syncRuntimeSkillsToGlobal(process.cwd(), {
          runtime,
          dryRun: args.includes("--dry-run"),
        })
      : await syncRuntimeSkills(process.cwd(), {
          runtime,
          target: target as string,
          dryRun: args.includes("--dry-run"),
        });

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${result.dryRun ? "Would sync" : "Synced"} runtime skills: ${result.runtime}`);
    console.log(`Mode: ${result.mode}`);
    console.log(`Source: ${result.sourceRoot}`);
    console.log(`Target: ${result.targetRoot}`);
    console.log(`Skills: ${result.syncedSkills.join(", ")}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log("Files:");
    for (const filePath of result.files) {
      console.log(`- ${filePath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function exportSkillCommand(args: string[]): Promise<void> {
  const target = args[1];
  const runtime = normalizeSkillRuntime(optionValue(args, "--runtime"));
  if (target === "--help" || target === "-h" || args.includes("--help") || args.includes("-h")) {
    printExportHelp();
    return;
  }

  if (!target || !runtime) {
    printExportHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const result = await exportProjectSkill(process.cwd(), {
      input: target,
      runtime,
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${result.dryRun ? "Would export" : "Exported"} project skill: ${result.module}/${result.name}`);
    console.log(`Runtime: ${result.runtime}`);
    console.log(`Source: ${result.sourcePath}`);
    if (result.sourceBuild !== null) {
      console.log(`Build: ${result.sourceBuild}`);
    }
    console.log(`Output: ${result.outputPath}`);
    console.log("Files:");
    for (const filePath of result.files) {
      console.log(`- ${filePath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}


async function learnSkillCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printLearnHelp();
    return;
  }

  if (args[1] === "apply") {
    await applyLearningProposalCommand(args);
    return;
  }

  const source = getLearningSource(args);
  if (!source) {
    console.error("Usage: keryx skills learn --from-review <path> --skill <module>/<skill>");
    printLearnHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const proposal = await learnProjectSkill(process.cwd(), {
      sourceType: source.type,
      sourcePath: source.path,
      skill: optionValue(args, "--skill"),
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(proposal, null, 2));
      return;
    }

    console.log(`${proposal.dryRun ? "Would create" : "Created"} learning proposal: ${proposal.proposalId}`);
    console.log(`Skill: ${proposal.skill.module}/${proposal.skill.name}`);
    console.log(`Source: ${proposal.sourcePath}`);
    console.log(`Confidence: ${proposal.confidence}`);
    console.log(`Proposal: ${proposal.proposalPath}`);
    console.log("Lessons:");
    if (proposal.lessons.length === 0) {
      console.log("- No concrete lessons extracted. Review source manually.");
    } else {
      for (const lesson of proposal.lessons) {
        console.log(`- ${lesson}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function applyLearningProposalCommand(args: string[]): Promise<void> {
  const proposalPath = args[2];
  if (!proposalPath) {
    console.error("Usage: keryx skills learn apply <proposal.json> [--dry-run] [--json]");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await applyLearningProposal(process.cwd(), proposalPath, {
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${result.dryRun ? "Would apply" : "Applied"} learning proposal: ${result.proposalId}`);
    console.log(`Skill: ${result.skillPath}`);
    console.log(`Version: ${result.previousVersion} -> ${result.nextVersion}`);
    console.log(`Changed sections: ${result.changedSections.join(", ")}`);
    console.log(`Audit: ${result.appliedReportPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function getLearningSource(args: string[]): { type: LearningSourceType; path: string } | undefined {
  const sources: Array<{ flag: string; type: LearningSourceType }> = [
    { flag: "--from-review", type: "review" },
    { flag: "--from-test", type: "test" },
    { flag: "--from-failure", type: "failure" },
    { flag: "--from-health", type: "health" },
    { flag: "--from-memory", type: "memory" },
  ];

  for (const source of sources) {
    const value = optionValue(args, source.flag);
    if (value) {
      return { type: source.type, path: value };
    }
  }

  return undefined;
}

async function verifySkillCommand(args: string[]): Promise<void> {
  const target = args[1];
  if (target === "--bundled" || args.includes("--bundled")) {
    verifyBundledSkills(args);
    return;
  }

  if (target === "--all" || args.includes("--all")) {
    await verifyAllProjectSkills(args);
    return;
  }

  if (!target || target === "--help" || target === "-h") {
    printVerifyHelp();
    if (!target) {
      process.exitCode = 1;
    }
    return;
  }

  try {
    const report = await verifyProjectSkill(process.cwd(), {
      input: target,
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`${report.dryRun ? "Would verify" : "Verified"} project skill: ${report.module}/${report.name}`);
    console.log(`Status: ${report.status}`);
    console.log(`Target: ${report.target}`);
    console.log(`Report: ${report.reportPath}`);
    console.log("Signals:");
    for (const signal of report.signals) {
      console.log(`- ${signal.status}: ${signal.name} - ${signal.message}`);
    }
    if (report.recommendations.length > 0) {
      console.log("Recommendations:");
      for (const recommendation of report.recommendations) {
        console.log(`- ${recommendation}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * `keryx skills verify --bundled` — structural validation of the SHIPPED skill
 * tree (flow 207, §5.3).
 *
 * WHY THIS EXISTS ALONGSIDE THE GUARD TEST, since the same predicate backs both.
 *
 * `src/gdskills/bundled-eval.test.ts` runs the identical sweep in CI, and that
 * is the thing that stops a regression reaching `main`. It is also unreachable
 * for the person the check is actually for: somebody authoring or editing a
 * bundled skill wants the verdict on the file in front of them, before they open
 * a pull request and long before CI has an opinion. A guard answers "did the
 * tree break"; a command answers "is this skill shippable", and those are asked
 * at different moments by different people.
 *
 * The two share `evaluateBundledTree`, so they cannot disagree — which is the
 * only reason shipping both is not two implementations of one rule. `--root`
 * exists so the command can be pointed at a tree that is not this package's own
 * (a fork's, or an unpacked release); `skills.bundled-verify.test.ts` uses it to
 * aim the command at a deliberately broken tree and assert the exit code.
 *
 * Exit 1 on any finding: a checker that reports defects and exits 0 is a checker
 * nothing can gate on.
 */
function verifyBundledSkills(args: string[]): void {
  const root = optionValue(args, "--root") ?? defaultBundledRoot();
  const evaluation = evaluateBundledTree(root);

  if (args.includes("--json")) {
    console.log(JSON.stringify(evaluation, null, 2));
  } else {
    console.log(renderBundledEvaluation(evaluation));
  }

  if (evaluation.skills === 0) {
    // Not a pass. `findings: 0` over an empty denominator is the exact defect
    // this sweep exists to remove, so it exits non-zero and says why.
    console.error(
      `\nNo SKILL.md found under ${path.join(root, "skills")}. Nothing was evaluated, so nothing was verified.`,
    );
    process.exitCode = 1;
    return;
  }
  if (evaluation.findings.length > 0) {
    process.exitCode = 1;
  }
}

async function verifyAllProjectSkills(args: string[]): Promise<void> {
  const manifestPath = path.join(process.cwd(), ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    console.error("Metaproject is not initialized. Run: keryx init");
    process.exitCode = 1;
    return;
  }

  let manifest: MetaprojectManifest;
  try {
    manifest = await readJsonFile<MetaprojectManifest>(manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const registry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  if (registry.length === 0) {
    if (args.includes("--json")) {
      console.log("[]");
    } else {
      console.log("No project skills registered.");
    }
    return;
  }

  const reports = [];
  for (const entry of registry) {
    reports.push(await verifyProjectSkill(process.cwd(), {
      input: `${entry.module}/${entry.name}`,
      dryRun: args.includes("--dry-run"),
    }));
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  console.log(`${args.includes("--dry-run") ? "Would verify" : "Verified"} project skills: ${reports.length}`);
  for (const report of reports) {
    console.log(`- ${report.status}: ${report.module}/${report.name} -> ${report.reportPath}`);
  }
}

export async function skillVerifySkillCommand(args: string[]): Promise<void> {
  await verifySkillCommand(["verify", ...args]);
}

async function createSkillCommand(args: string[]): Promise<void> {
  const command = args[0];
  const target = args[1];
  if (!target || target === "--help" || target === "-h") {
    printCreateHelp(command === "generate" ? "generate" : "create");
    if (!target) {
      process.exitCode = 1;
    }
    return;
  }

  try {
    const result = await createProjectSkill(process.cwd(), {
      target,
      module: optionValue(args, "--module"),
      name: optionValue(args, "--name"),
      note: optionValue(args, "--note"),
      origin: optionValue(args, "--origin"),
      format: normalizeProjectSkillFormat(optionValue(args, "--format")),
      dryRun: args.includes("--dry-run"),
    });

    console.log(`${result.dryRun ? "Would create" : "Created"} project skill: ${result.module}/${result.name}`);
    console.log(`Target: ${result.target}`);
    console.log(`Path: ${result.skillPath}`);
    if (result.files.length > 0) {
      console.log("Files:");
      for (const filePath of result.files) {
        console.log(`- ${filePath}`);
      }
    }
    if (result.warnings.length > 0) {
      console.log("Warnings:");
      for (const warning of result.warnings) {
        console.log(`- ${warning}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function contractsCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printContractsHelp();
    return;
  }

  if (command === "list") {
    for (const contract of CONTRACTS) {
      console.log(`${contract.name}\t${relativeContractPath(contract)}\t${contract.description}`);
    }
    return;
  }

  if (command === "validate") {
    const filePath = args[1];
    const schemaName = normalizeContractName(optionValue(args, "--schema"));
    if (!filePath || !schemaName) {
      console.error("Usage: keryx skills contracts validate <file> --schema <name>");
      printContractsHelp();
      process.exitCode = 1;
      return;
    }

    try {
      const result = await validateContractFile(path.resolve(filePath), schemaName);
      if (result.valid) {
        console.log(`valid: ${result.file}`);
        console.log(`schema: ${result.schema}`);
        return;
      }

      console.error(`invalid: ${result.file}`);
      console.error(`schema: ${result.schema}`);
      for (const error of result.errors) {
        console.error(`- ${error.path}: ${error.message}`);
      }
      process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Unknown contracts command: ${command}`);
  printContractsHelp();
  process.exitCode = 1;
}

async function printGdskillsStatus(args: string[]): Promise<void> {
  const summary = await getGdskillsStatusSummary();

  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!summary.initialized) {
    console.log("gdskills: not initialized");
    console.log("Run: keryx init");
    return;
  }

  console.log(`gdskills: ${summary.enabled ? "enabled" : "not enabled in manifest"}`);
  console.log(`profile: ${summary.profile}`);
  console.log(`bundled skills in profile: ${summary.bundledSkillsInProfile}`);
  console.log(`installed skills root: ${summary.installedSkillsRoot}`);
  console.log(`catalog: ${summary.catalog}`);
  console.log(`project skills registered: ${summary.projectSkills.registered}`);
  console.log(`project skills without verification report: ${summary.projectSkills.withoutVerificationReport}`);
  console.log(
    `verification reports: ${summary.verificationReports.total} ` +
      `(fresh ${summary.verificationReports.fresh}, needs-review ${summary.verificationReports.needsReview}, ` +
      `stale ${summary.verificationReports.stale}, blocked ${summary.verificationReports.blocked})`,
  );
  console.log(`last verified: ${summary.verificationReports.lastVerified}`);
  console.log(
    `learning proposals: ${summary.learningProposals.total} ` +
      `(pending ${summary.learningProposals.pending}, applied ${summary.learningProposals.applied})`,
  );
}

async function getGdskillsStatusSummary(): Promise<GdskillsStatusSummary> {
  const root = path.join(process.cwd(), ".metaproject");
  const manifestPath = path.join(root, "metaproject.json");
  const catalogPath = path.join(root, "skills", "catalog.md");
  const skillsRoot = path.join(root, "skills", "gdskills");

  if (!(await pathExists(root))) {
    return {
      initialized: false,
      enabled: false,
      profile: "recommended",
      bundledSkillsInProfile: getBundledSkillsForProfile("recommended").length,
      installedSkillsRoot: "missing",
      catalog: "missing",
      projectSkills: {
        registered: 0,
        withoutVerificationReport: 0,
      },
      verificationReports: {
        total: 0,
        fresh: 0,
        needsReview: 0,
        stale: 0,
        blocked: 0,
        lastVerified: "never",
      },
      learningProposals: {
        total: 0,
        pending: 0,
        applied: 0,
      },
    };
  }

  let profile: GdskillsProfile = "recommended";
  let enabled = false;
  let projectSkillRegistry: ProjectSkillRegistryEntry[] = [];
  if (await pathExists(manifestPath)) {
    const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
    enabled = manifest.modules?.gdskills?.enabled === true;
    profile = normalizeGdskillsProfile(manifest.modules?.gdskills?.profile);
    projectSkillRegistry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  }

  const reports = await readVerificationReports(path.join(root, "data", "gdskills", "reports"));
  const reportKeys = new Set(reports.map((report) => `${report.module}/${report.name}`));
  const proposals = await readProposalFiles(path.join(root, "data", "gdskills", "proposals"));
  const statusCounts = countVerificationStatuses(reports);

  return {
    initialized: true,
    enabled,
    profile,
    bundledSkillsInProfile: getBundledSkillsForProfile(profile).length,
    installedSkillsRoot: (await pathExists(skillsRoot)) ? relativeToCwd(skillsRoot) : "missing",
    catalog: (await pathExists(catalogPath)) ? relativeToCwd(catalogPath) : "missing",
    projectSkills: {
      registered: projectSkillRegistry.length,
      withoutVerificationReport: projectSkillRegistry.filter((entry) => !reportKeys.has(`${entry.module}/${entry.name}`)).length,
    },
    verificationReports: {
      total: reports.length,
      fresh: statusCounts.fresh,
      needsReview: statusCounts["needs-review"],
      stale: statusCounts.stale,
      blocked: statusCounts.blocked,
      lastVerified: latest(reports.map((report) => report.verifiedAt)),
    },
    learningProposals: proposals,
  };
}

type VerificationReportSummary = {
  module: string;
  name: string;
  status: "fresh" | "needs-review" | "stale" | "blocked";
  verifiedAt: string;
};

async function readVerificationReports(reportsRoot: string): Promise<VerificationReportSummary[]> {
  const files = await listJsonFiles(reportsRoot);
  const reports: VerificationReportSummary[] = [];
  for (const filePath of files) {
    try {
      const report = await readJsonFileOr<Partial<VerificationReportSummary>>(filePath, {});
      if (report.module && report.name && report.status && report.verifiedAt) {
        reports.push({
          module: report.module,
          name: report.name,
          status: report.status,
          verifiedAt: report.verifiedAt,
        });
      }
    } catch {
      // Ignore malformed reports in summary mode; verifier will surface details when run directly.
    }
  }

  return reports;
}

async function readProposalFiles(proposalsRoot: string): Promise<GdskillsStatusSummary["learningProposals"]> {
  const files = await listJsonFiles(proposalsRoot);
  const appliedIds = new Set(
    files
      .filter((filePath) => filePath.endsWith(".applied.json"))
      .map((filePath) => path.basename(filePath).replace(/\.applied\.json$/, "")),
  );
  const proposalIds = files
    .filter((filePath) => !filePath.endsWith(".applied.json"))
    .map((filePath) => path.basename(filePath).replace(/\.json$/, ""));

  return {
    total: proposalIds.length,
    pending: proposalIds.filter((id) => !appliedIds.has(id)).length,
    applied: appliedIds.size,
  };
}

async function listJsonFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(root, entry.name));
}

function countVerificationStatuses(
  reports: VerificationReportSummary[],
): Record<VerificationReportSummary["status"], number> {
  return reports.reduce(
    (acc, report) => {
      acc[report.status] += 1;
      return acc;
    },
    {
      fresh: 0,
      "needs-review": 0,
      stale: 0,
      blocked: 0,
    },
  );
}

function latest(values: string[]): string | "never" {
  const sorted = values.filter(Boolean).sort();
  return sorted.at(-1) ?? "never";
}

function relativeToCwd(filePath: string): string {
  return path.relative(process.cwd(), filePath) || ".";
}

function printSkillsHelp(): void {
  console.log(`keryx skills

Usage:
  keryx skills status
  keryx skills status --json
  keryx skills list
  keryx skills inspect <project-skill>
  keryx skills route <query-or-target>
  keryx skills catalog [--profile minimal|recommended|full|custom]
  keryx skills install [--profile minimal|recommended|full|custom]
  keryx skills install --profile <manifest-profile> [--with <component>]... [--without <component>]...
      [--target <harness>] [--include-deprecated] [--dry-run] [--json] [--force]
  keryx skills doctor [--target <harness>] [--json]
  keryx skills uninstall --target <harness> [--module <module-id>] [--force] [--json]
  keryx skills create <target> --module <module> --name <skill-name>
  keryx skills generate <target> --module <module> --name <skill-name>
  keryx skills import --from <dir|SKILL.md|https-url> [--module <module>] [--name <name>]
  keryx skills update [<module>/<name>|--all] [--from <origin>]
  keryx skills verify <skill-or-target>
  keryx skills verify --all
  keryx skills verify --bundled [--root <dir>] [--json]
  keryx skills learn --from-review <path> --skill <module>/<skill>
  keryx skills learn apply <proposal.json>
  keryx skills export <project-skill> --runtime codex|claude
  keryx skills sync --runtime codex|claude --target <dir>
  keryx skills contracts list
  keryx skills contracts validate <file> --schema <name>
  keryx skills scout <name-or-description> [--record <pack-dir>] [--include-imports] [--candidate <dir>] [--scope bundled|all]
              [--origin learned --source-ref <id>] [--json]
  keryx skills eval <skill-id> [--strictness low|medium|high] [--trials N] [--runner <provider>]
              [--judge <provider>[:<model>]] [--model-grader] [--json]
  keryx skills judge-check <skill-id> --judge <provider>[:<model>] [--scope bundled|all] [--record] [--json]
  keryx skills stocktake [--scope bundled|all] [--quick] [--json]

Commands:
  status    Show local gdskills installation status
  list      List registered project skills
  inspect   Inspect one registered project skill
  route     Route a query or target to matching project skills
  catalog   Print bundled gdskills catalog for a profile
  install   Install bundled gdskills into .metaproject (legacy profile), or resolve/apply a
            profile->modules/components install-manifest plan (--with/--without/--target/
            --dry-run/--json/--include-deprecated, or a non-legacy profile id such as
            core|react|nestjs|python). --target only accepts claude|keryx-shell (the only
            targets with a v1 destination table) — any other value is a named error, never
            an empty plan. --profile/--target/--with/--without given with no usable value
            (a bare trailing flag, immediately followed by another flag, or --flag= with
            nothing after it) is also a named error, never a silent default. NOTE:
            --dry-run/--json on a LEGACY profile id (minimal|full|...) with no other
            manifest flag always previews the MANIFEST-driven installer's own same-named
            profile, which can differ from the legacy install the same command without
            --dry-run/--json would run; the CLI prints this note when it applies.
  doctor    Compare recorded install-state to disk: ok/drifted/missing/orphaned per path.
            orphaned is a file under this target's destination roots that install-state
            doesn't know about (often the operator's own file, e.g. .claude/rules/my-own.md)
            — it is reported but never fails the command; only a drifted/missing recorded
            path, or an unreadable/unsafe install-state file, sets a non-zero exit code.
            --target with no usable value is a named error, never a silent default.
  uninstall Remove only the paths recorded in install-state for a target (optionally one
            module). --target/--module with no usable value is a named error, never a
            silent default.
  create    Create a canonical project skill package
  generate  Alias for create
  import    Copy a SKILL.md or overlay tree into project-skills
  update    Re-read a project-skill Origin and overwrite SKILL.md
  verify    Verify a project skill, or --bundled for the shipped skill tree
  learn     Create or apply auditable learning proposals
  export    Export a canonical project skill to a runtime artifact
  sync      Sync exported runtime skills to an explicit target directory
  contracts List and validate gdskills JSON contracts
  scout     Pre-creation dedupe gate: does an existing skill already cover this?
  eval      Behavioral compliance eval: trigger accuracy + scenario pass rate. --judge
            <provider>[:<model>] grades judge-graded behavior scenarios with a live LLM judge.
  judge-check Proves a skill's judge-graded scenarios are hard to game: runs the canned
              empty/echo/known-wrong/injection/stuffed/known-right answers through the live
              judge and exits 1 on any mismatch. --record saves the verdicts for offline replay.
  stocktake Periodic catalog health check: keep|improve|update|retire|merge
`);
}

function printDoctorHelp(): void {
  console.log(`keryx skills doctor

Compares recorded install-state to disk for one target: ok/drifted/missing/orphaned per path.
orphaned is a file under the target's destination roots that install-state doesn't know about
(reported, never fails the command); only a drifted/missing recorded path, or an unreadable/
unsafe install-state file, sets a non-zero exit code.

Usage:
  keryx skills doctor [--target <harness>] [--json]

Examples:
  keryx skills doctor
  keryx skills doctor --target claude --json
`);
}

function printUninstallHelp(): void {
  console.log(`keryx skills uninstall

Removes only the paths recorded in install-state for a target (optionally one module).

Usage:
  keryx skills uninstall --target <harness> [--module <module-id>] [--force] [--json]

Examples:
  keryx skills uninstall --target claude
  keryx skills uninstall --target claude --module core --force
`);
}

function printRouteHelp(): void {
  console.log(`keryx skills route

Routes a query across BOTH bundled catalog skills (planning/orchestration/
review/…) and per-module project-skills. Matches by name, description, triggers,
and workflow — English or Russian.

Usage:
  keryx skills route <query-or-target> [--json]

Examples:
  keryx skills route src/pipelines/PipelineStepStore.ts
  keryx skills route "подготовь пакет документации"
  keryx skills route "change pipeline step store behavior" --json
`);
}

function printInspectHelp(): void {
  console.log(`keryx skills inspect

Usage:
  keryx skills inspect <project-skill> [--json]

Examples:
  keryx skills inspect pipelines/pipeline-step-store
  keryx skills inspect .metaproject/project-skills/pipelines/pipeline-step-store --json
`);
}

function printCreateHelp(command: "create" | "generate"): void {
  console.log(`keryx skills ${command}

Usage:
  keryx skills ${command} <target> --module <module> --name <skill-name>
      [--note <one-line gist>] [--origin <source file>]
      [--format auto|single|package] [--dry-run]

<target> is a ROUTING KEY, not a description: \`keryx skills route\` matches
queries against it and \`verify\` resolves it as a path. Keep it a path, a
symbol, or a short concept. Put the sentence in --note.

--origin records the external file this skill was built from — a rules file, a
review profile, a conventions doc. The path is stored verbatim and its content
hashed, so \`keryx review reviewers\` can later report that the source has moved
on since the import.

A project-skill under --module review is a REVIEWER: it lands at
.metaproject/project-skills/review/<name>/, mirroring where bundled reviewers
live, and \`review-orchestrator\` dispatches it alongside them.

Examples:
  keryx skills ${command} src/pipelines --module pipelines --name pipelines-module
  keryx skills ${command} PipelineStepStore --module pipelines --name pipeline-step-store --dry-run
  keryx skills ${command} "review profile" --module review --name b091-profile \\
      --origin ~/.vantage-frontend/rules/core/code-review-b091-profile.mdc
`);
}

function printVerifyHelp(): void {
  console.log(`keryx skills verify

Usage:
  keryx skills verify <skill-or-target> [--dry-run] [--json]
  keryx skills verify --all [--dry-run] [--json]
  keryx skills verify --bundled [--root <dir>] [--json]

Aliases:
  keryx skill-verify-skill <skill-or-target>

--bundled evaluates the SHIPPED skill tree (the 65 SKILL.md files copied into
every installation), not this project's generated project-skills. It runs LAYER
ONE of the three-layer bar only — structural validation: required frontmatter,
resolvable cross-references, no concrete model name, no persona or personal home
path, and registration in the install catalogue. It does NOT judge whether a
skill's instructions are correct or useful; that needs a model in the loop and is
not built. Exits 1 on any finding, and on an empty tree.

Examples:
  keryx skills verify pipelines/pipeline-step-store
  keryx skills verify .metaproject/project-skills/pipelines/pipeline-step-store --json
  keryx skills verify --bundled
  keryx skills verify --bundled --json
`);
}

function printLearnHelp(): void {
  console.log(`keryx skills learn

Usage:
  keryx skills learn --from-review <path> --skill <module>/<skill> [--dry-run] [--json]
  keryx skills learn --from-test <path> --skill <module>/<skill>
  keryx skills learn --from-failure <path> --skill <module>/<skill>
  keryx skills learn --from-health <path> --skill <module>/<skill>
  keryx skills learn --from-memory <path> --skill <module>/<skill>
  keryx skills learn apply <proposal.json> [--dry-run] [--json]

Notes:
  Proposal creation does not mutate SKILL.md. The explicit apply command updates SKILL.md and skill-changelog.md.
`);
}

function printExportHelp(): void {
  console.log(`keryx skills export

Usage:
  keryx skills export <project-skill> --runtime <runtime> [--dry-run] [--json]

Runtimes:
  claude    SKILL.md
  codex     SKILL.md, or SKILL.codex.md when the skill ships one
  cursor    SKILL.md, or SKILL.cursor.md when the skill ships one
  zed       SKILL.md, or SKILL.zed.md when the skill ships one
  opencode  SKILL.md, or SKILL.opencode.md when the skill ships one
  plugin    marketplace package layout

Notes:
  SKILL.md is the build every harness reads. A skill ships SKILL.<runtime>.md
  only when that harness needs different content, and then that runtime gets
  it. The build used is reported as "Build:" and recorded as sourceBuild in
  export-manifest.json.

Examples:
  keryx skills export pipelines/pipeline-step-store --runtime codex
  keryx skills export .metaproject/project-skills/pipelines/pipeline-step-store --runtime claude --dry-run
  keryx skills export pipelines/pipeline-step-store --runtime plugin
`);
}

function printSyncHelp(): void {
  const mapping = GLOBAL_SYNC_RUNTIMES.map((runtime) => {
    let documented: string;
    try {
      documented = resolveGlobalSyncTarget(runtime).documented;
    } catch {
      documented = "(unresolved)";
    }
    return `  ${runtime.padEnd(9)} ${documented}`;
  }).join("\n");

  console.log(`keryx skills sync

Usage:
  keryx skills sync --runtime <runtime> --target <dir> [--dry-run] [--json]
  keryx skills sync --runtime <runtime> --global [--dry-run] [--json]

Global sync mapping (rules/core/skills-storage-workflow.mdc):
${mapping}

Notes:
  --global is opt-in and writes outside the project, into the harness's own
  home directory. No other command performs it: it never runs as a side effect
  of keryx update. If the harness home does not exist, sync refuses instead of
  creating directory trees in your home.

  claude and plugin have no global destination — use --target for those.

Examples:
  keryx skills sync --runtime codex --target .metaproject/runtime/synced/codex
  keryx skills sync --runtime cursor --global --dry-run
  keryx skills sync --runtime zed --global
`);
}

function printContractsHelp(): void {
  const schemas = CONTRACTS.map((contract) => `  ${contract.name}`).join("\n");

  console.log(`keryx skills contracts

Usage:
  keryx skills contracts list
  keryx skills contracts validate <file> --schema <name>

Schemas:
${schemas}
`);
}
