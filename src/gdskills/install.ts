import { lstat, readFile, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../lib/fs";
import { ContainedWriteError, mkdirContained, writeContained } from "../lib/contained-write";
import { CONTRACTS, contractPath } from "./contracts";
import {
  type GdskillsProfile,
  getBundledSkillsForProfile,
  renderBundledSkill,
  renderGdskillsCatalog,
  renderGdskillsManifest,
} from "./catalog";
import {
  bundledSkillSourcePath,
  copyDirectoryContained,
  errorCodeOf,
  isErrnoException,
  isMissingPathError,
  removeStaleRuntimeBuilds,
  removeUnmodifiedRetiredRules,
  retiredRuleWarning,
  staleRuntimeBuildMessage,
  staleRuntimeBuildSeverity,
} from "./guarded-fs-ops";
import type { RetiredRuleOutcome } from "./retired-rules";

/**
 * `mkdirContained`, but a containment refusal becomes a warning string
 * instead of a thrown `ContainedWriteError` — matching
 * `checkInstallDestination`'s posture: a directory keryx cannot safely
 * create (an escaping symlink or cycle anywhere on the path, a dangling
 * link, a non-directory in the way) is reported and simply not created,
 * rather than aborting the whole install (R1-F1).
 */
async function mkdirContainedOrWarn(metaprojectRoot: string, target: string): Promise<string | null> {
  const rel = path.relative(metaprojectRoot, target);
  try {
    await mkdirContained(metaprojectRoot, rel);
    return null;
  } catch (error) {
    if (error instanceof ContainedWriteError) {
      return `${rel} was not created because ${error.message}`;
    }
    throw error;
  }
}

export type InstallGdskillsResult = {
  profile: GdskillsProfile;
  installedSkills: number;
  skillsRoot: string;
  catalogPath: string;
  manifestPath: string;
  /**
   * Things the operator has to act on, same convention as `createProjectSkill`'s
   * result (`src/gdskills/project-skills.ts`): plain strings a caller prints
   * under a "Warnings:" heading. Every entry names a file keryx would have
   * cleaned up or written and did NOT — a retired rule kept because it was
   * modified, oversized or unreadable (see `retired-rules.ts`), a stale
   * per-runtime build kept because it is a symlink or its `unlink` failed, a
   * directory left unswept, an install destination skipped because it is not a
   * plain directory (see `checkInstallDestination`) — so each one leaves
   * something to do by hand.
   */
  warnings: string[];
  /**
   * Informational outcomes: work that succeeded exactly as designed, chiefly
   * the per-runtime builds `removeStaleRuntimeBuilds` deleted. Reported so no
   * file leaves a project's tree without the operator being told, but kept out
   * of `warnings` because nothing is wrong and nothing is owed: the release
   * that retired the identical-copy builds removes ~88 of them on a project's
   * first `keryx update`, and 88 lines under "Warnings" for a clean sweep
   * teaches an operator to skip the heading that matters.
   */
  notices: string[];
};

export type InstallGdskillsOptions = {
  createDataDirs?: boolean;
};

export async function installGdskills(
  metaprojectRoot: string,
  profile: GdskillsProfile,
  options: InstallGdskillsOptions = {},
): Promise<InstallGdskillsResult> {
  const skills = getBundledSkillsForProfile(profile);
  const skillsRoot = path.join(metaprojectRoot, "skills", "gdskills");
  const dataRoot = path.join(metaprojectRoot, "data", "gdskills");
  const coreRoot = path.join(metaprojectRoot, "core", "gdskills");
  const contractsRoot = path.join(coreRoot, "contracts");
  const projectSkillsRoot = path.join(metaprojectRoot, "project-skills");

  const skippedDestinationWarnings: string[] = [];

  // R1-F1: each scaffold directory is containment-checked individually,
  // never as one `Promise.all` — a single escaping symlink anywhere used to
  // be either silently followed (the vulnerability) or, naively routed
  // through `mkdirContained` in a batch, would abort the WHOLE install with
  // an uncaught exception the first time any one of them refused. Neither is
  // right: a directory keryx cannot safely create is reported as a warning
  // and simply not created, the same posture `checkInstallDestination`
  // already takes for a write target, and the rest of the install proceeds.
  // `skillsRoot` and `contractsRoot` are deliberately NOT pre-created here:
  // every write beneath them re-validates full-path containment on its own
  // (the per-skill loop's own `mkdirContained` below, and `installContracts`'s
  // `checkInstallDestination` + `writeContained`, which creates its own
  // parent directories) — pre-creating them here would only add a second,
  // redundant place this could silently diverge from those checks.
  for (const dir of [
    path.join(metaprojectRoot, "jobs"),
    path.join(metaprojectRoot, "modules"),
    projectSkillsRoot,
    ...(options.createDataDirs === false ? [] : [
      path.join(dataRoot, "artifacts"),
      path.join(dataRoot, "reports"),
      path.join(dataRoot, "proposals"),
    ]),
  ]) {
    const warning = await mkdirContainedOrWarn(metaprojectRoot, dir);
    if (warning) skippedDestinationWarnings.push(warning);
  }
  let installedSkills = 0;

  for (const skillEntry of skills) {
    const skillDir = path.join(skillsRoot, skillEntry.category, skillEntry.name);
    const relSkillDir = path.relative(metaprojectRoot, skillDir);
    const destination = await checkInstallDestination(skillDir, relSkillDir);
    if (!destination.usable) {
      skippedDestinationWarnings.push(destination.warning);
      continue;
    }
    // mkdirContainedOrWarn walks metaprojectRoot -> relSkillDir segment by
    // segment, refusing an escaping symlink anywhere on the path (R1-F1) —
    // the gap `checkInstallDestination` above does not close, since it only
    // lstats the FINAL component (a symlinked CATEGORY directory, for
    // example, leaves `skillDir` itself lstat-ing as a plain directory
    // reached THROUGH the link).
    const mkdirWarning = await mkdirContainedOrWarn(metaprojectRoot, skillDir);
    if (mkdirWarning) {
      skippedDestinationWarnings.push(mkdirWarning);
      continue;
    }
    const bundledSkillPath = bundledSkillSourcePath(skillEntry.category, skillEntry.name);
    if (existsSync(bundledSkillPath)) {
      // Known, pre-existing, and NOT addressed here: if `skillDir` is a symlink
      // (a relocated or shared skill directory), `fs.cp` on Linux refuses to
      // overwrite a non-directory with a directory — `ERR_FS_CP_DIR_TO_NON_DIR`
      // / `EISDIR` — and the rejection aborts the whole install, including the
      // sweep and rule cleanup below. macOS's `cp` accepts the same call, so the
      // difference only shows on Linux (it surfaced as a CI-only failure in flow
      // 257 T24). Changing the copy strategy is out of that flow's scope; this
      // note exists so the next person does not rediscover it from a CI log.
      //
      // `cp` itself has no containment primitive to route through (it copies a
      // whole directory tree, not a single file). The `mkdirContained` just
      // above already confirmed `skillDir` resolves inside `metaprojectRoot`
      // with no escaping symlink anywhere on the way — belt-and-braces, not
      // gap-free (a symlink swapped in between the two calls is not caught),
      // the same narrowing every other TOCTOU note in this file accepts.
      await copyDirectoryContained(bundledSkillPath, skillDir);
    } else {
      await writeContained(metaprojectRoot, path.join(relSkillDir, "SKILL.md"), renderBundledSkill(skillEntry));
    }
    installedSkills += 1;
  }

  const staleBuildOutcomes = await removeStaleRuntimeBuilds(skillsRoot);
  const sharedWarning = await installBundledSharedSkills(skillsRoot, metaprojectRoot);
  if (sharedWarning !== null) {
    skippedDestinationWarnings.push(sharedWarning);
  }
  const rulesInstall = await installBundledRules(metaprojectRoot);
  if (rulesInstall.warning !== null) {
    skippedDestinationWarnings.push(rulesInstall.warning);
  }
  const retiredRuleOutcomes = rulesInstall.outcomes;

  const catalogPath = path.join(metaprojectRoot, "skills", "catalog.md");
  await writeContained(
    metaprojectRoot,
    path.relative(metaprojectRoot, catalogPath),
    await preserveProjectSkillsSection(catalogPath, renderGdskillsCatalog(profile)),
  );

  const manifestPath = path.join(metaprojectRoot, "modules", "gdskills.md");
  await writeContained(metaprojectRoot, path.relative(metaprojectRoot, manifestPath), renderGdskillsManifest(profile));

  skippedDestinationWarnings.push(...await installContracts(contractsRoot, metaprojectRoot));

  const projectRoot = path.dirname(metaprojectRoot);
  // Every stale-build outcome is reported, removals included — but a removal
  // is the sweep working, so it goes to `notices` and only the outcomes that
  // left a file behind go to `warnings` (see `staleRuntimeBuildSeverity`).
  // Skipped install destinations lead: a skill that was never written is a
  // bigger fact about this install than a leftover the sweep could not clear.
  const warnings = [
    ...skippedDestinationWarnings,
    ...retiredRuleOutcomes.map(retiredRuleWarning).filter((warning): warning is string => warning !== null),
    ...staleBuildOutcomes
      .filter((outcome) => staleRuntimeBuildSeverity(outcome) === "warning")
      .map((outcome) => staleRuntimeBuildMessage(outcome, projectRoot)),
  ];
  const notices = staleBuildOutcomes
    .filter((outcome) => staleRuntimeBuildSeverity(outcome) === "notice")
    .map((outcome) => staleRuntimeBuildMessage(outcome, projectRoot));

  return {
    profile,
    installedSkills,
    skillsRoot,
    catalogPath,
    manifestPath,
    warnings,
    notices,
  };
}

async function installBundledSharedSkills(skillsRoot: string, metaprojectRoot: string): Promise<string | null> {
  const sharedSource = bundledSharedSourcePath();
  if (!existsSync(sharedSource)) {
    return null;
  }
  const sharedTarget = path.join(skillsRoot, "shared");
  const relSharedTarget = path.relative(metaprojectRoot, sharedTarget);
  const destination = await checkInstallDestination(sharedTarget, relSharedTarget);
  if (!destination.usable) {
    return destination.warning;
  }
  // See the identical note in installGdskills's per-skill loop:
  // mkdirContainedOrWarn confirms containment before the raw recursive `cp`,
  // refusing (with a warning, not a crash) rather than following an
  // escaping symlink.
  const mkdirWarning = await mkdirContainedOrWarn(metaprojectRoot, sharedTarget);
  if (mkdirWarning) {
    return mkdirWarning;
  }
  await copyDirectoryContained(sharedSource, sharedTarget);
  return null;
}

export type InstallDestinationCheck =
  | { usable: true }
  | { usable: false; warning: string };

/**
 * Decide whether an install target is a directory keryx may copy over, and
 * describe it in the result's `warnings` when it is not.
 *
 * A symlink at an install target is a real shape — a shared checkout, a
 * relocated tree, a skill kept under version control elsewhere — and the two
 * platforms disagreed about it in opposite, equally wrong directions. On Linux
 * `cp(dir, symlink, { recursive: true })` throws `ERR_FS_CP_DIR_TO_NON_DIR`
 * (EISDIR) out of `installGdskills`, so not one rule, contract or skill is
 * written: the whole install dies on one linked directory. On macOS the same
 * call *succeeds* by following the link and writing the bundled tree into
 * whatever directory it points at — silently overwriting files outside
 * `.metaproject` entirely. That divergence is why this never surfaced locally.
 *
 * Both are fixed by one rule, the same posture `removeUnmodifiedRetiredRules`
 * takes for a retired rule's name: `lstat`, never follow the link, and never
 * write through something that is not what we expected to find. A destination
 * that is not a plain directory is left exactly as it is, the operator is told
 * which path was skipped and what it is, and the rest of the install proceeds.
 *
 * `ENOENT` is the ordinary case (a fresh install), not a problem: nothing is
 * there, so the caller's `mkdir` will create it.
 */
export async function checkInstallDestination(
  destination: string,
  displayPath: string,
): Promise<InstallDestinationCheck> {
  let stats;
  try {
    stats = await lstat(destination);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { usable: true };
    }
    return {
      usable: false,
      warning: `${displayPath} was not updated because it could not be inspected `
        + `(${isErrnoException(error) && error.code ? error.code : "UNKNOWN"}) — `
        + `check its permissions, then re-run the install`,
    };
  }

  if (stats.isDirectory()) {
    return { usable: true };
  }

  if (stats.isSymbolicLink()) {
    // `readlink` is only for the message. If it fails the skip still stands —
    // the decision was already made by `lstat`, which never followed the link.
    const linkTarget = await readlink(destination).catch(() => null);
    const where = linkTarget === null ? "" : ` (-> ${linkTarget})`;
    return {
      usable: false,
      warning: `${displayPath} was not updated because it is a symlink${where}; keryx will not write `
        + `through it — replace it with a real directory to let keryx manage it, or update whatever `
        + `the link points at yourself`,
    };
  }

  return {
    usable: false,
    warning: `${displayPath} was not updated because it is not a directory (a regular file, FIFO, or `
      + `similar); keryx will not overwrite it — delete or rename it, then re-run the install`,
  };
}

/**
 * Force-copy the bundled rules over the project's installed copy, then clean
 * up any rule this bundle no longer ships (see `retired-rules.ts` for why a
 * plain `cp` can't do that itself).
 *
 * Returns one `RetiredRuleOutcome` per retired-rule file name found in the
 * target directory (after the copy — so a rule retired in this very release
 * is caught on the run that retires it, not the next one). A retired name
 * absent from the target directory produces no outcome; that is the steady
 * state once every installation has caught up.
 *
 * If `rules/core` itself is not a plain directory (`checkInstallDestination`),
 * neither the copy nor the retired-rule cleanup runs: cleanup walks the same
 * directory, and reading or unlinking through a link the operator put there is
 * the same hazard as writing through it.
 */
async function installBundledRules(
  metaprojectRoot: string,
): Promise<{ outcomes: RetiredRuleOutcome[]; warning: string | null }> {
  const rulesSource = bundledRulesSourcePath();
  const rulesTarget = path.join(metaprojectRoot, "rules", "core");
  if (!existsSync(rulesSource)) {
    return { outcomes: [], warning: null };
  }
  const relRulesTarget = path.relative(metaprojectRoot, rulesTarget);
  const destination = await checkInstallDestination(rulesTarget, relRulesTarget);
  if (!destination.usable) {
    return { outcomes: [], warning: destination.warning };
  }
  // See the identical note in installGdskills's per-skill loop:
  // mkdirContainedOrWarn confirms containment before the raw recursive `cp`,
  // refusing (with a warning, not a crash) rather than following an
  // escaping symlink.
  const mkdirWarning = await mkdirContainedOrWarn(metaprojectRoot, rulesTarget);
  if (mkdirWarning) {
    return { outcomes: [], warning: mkdirWarning };
  }
  await copyDirectoryContained(rulesSource, rulesTarget);
  return { outcomes: await removeUnmodifiedRetiredRules(rulesTarget), warning: null };
}

async function preserveProjectSkillsSection(catalogPath: string, nextCatalog: string): Promise<string> {
  if (!(await pathExists(catalogPath))) {
    return nextCatalog;
  }

  const current = await readFile(catalogPath, "utf8");
  const start = "<!-- gdskills:project-skills:start -->";
  const end = "<!-- gdskills:project-skills:end -->";
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  if (startIndex === -1 || endIndex <= startIndex) {
    return nextCatalog;
  }

  const section = current.slice(startIndex, endIndex + end.length);
  return `${nextCatalog.trimEnd()}\n\n${section}\n`;
}

/**
 * Mirror every registered contract into `.metaproject/core/gdskills/contracts/`.
 *
 * Derived from `CONTRACTS` rather than from a second hand-written list. The list
 * that used to live here named five files while the registry named five, and the
 * job-orchestrator state schema was in neither — so it could not be validated
 * and was not installed. Deriving means adding a contract to the registry
 * installs it, with no way to add one and forget this.
 *
 * A contract that declares `sourcePath` (its authoritative file lives with the
 * skill that owns it) is resolved through `contractPath`; the rest keep the
 * original `contracts/<fileName>` lookup.
 *
 * Returns one warning per contract that was NOT written. `copyFile` FOLLOWS a
 * symlinked destination and overwrites whatever it points at, so a contract
 * name someone has linked elsewhere would be a silent write outside
 * `.metaproject` — the same hazard `checkInstallDestination` closes for the
 * directory copies, with a quieter failure mode: no error, just a modified file
 * the operator never named. `checkInstallFile` closes it here.
 */
async function installContracts(contractsRoot: string, metaprojectRoot: string): Promise<string[]> {
  // The directory itself first: a symlinked `contracts/` would send every
  // entry below through the link, and `mkdir(…, { recursive: true })` follows
  // it without complaint.
  const rootCheck = await checkInstallDestination(contractsRoot, path.relative(metaprojectRoot, contractsRoot));
  if (!rootCheck.usable) {
    return [rootCheck.warning];
  }

  const results = await Promise.all(
    CONTRACTS.map(async (contract) => {
      const destination = path.join(contractsRoot, contract.fileName);
      const relDestination = path.relative(metaprojectRoot, destination);
      const check = await checkInstallFile(destination, relDestination);
      if (!check.usable) {
        return check.warning;
      }
      const sourcePath = contract.sourcePath ? contractPath(contract) : contractSourcePath(contract.fileName);
      // Routed through writeContained rather than `copyFile` (R1-F1):
      // `copyFile` FOLLOWS a symlinked destination (see the file-header note
      // above), and writeContained's containment walk refuses an escaping
      // symlink anywhere on `relDestination`'s path, not just the final
      // component `checkInstallFile` already lstats.
      await writeContained(metaprojectRoot, relDestination, await readFile(sourcePath));
      return null;
    }),
  );
  return results.filter((warning): warning is string => warning !== null);
}

/**
 * The single-file counterpart to `checkInstallDestination`: may keryx write
 * this path as a plain file?
 *
 * Missing is the ordinary case, and an existing regular file is the steady
 * state of a re-install — `copyFile` replacing it is exactly right. Everything
 * else is refused for the same reason the directory check refuses: a symlink
 * would be written THROUGH, silently landing the bundled contents somewhere
 * the operator never pointed keryx at, and a directory (or FIFO, socket,
 * device) at a file's name is not something to overwrite unasked.
 */
export async function checkInstallFile(
  destination: string,
  displayPath: string,
): Promise<InstallDestinationCheck> {
  let stats;
  try {
    stats = await lstat(destination);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { usable: true };
    }
    return {
      usable: false,
      warning: `${displayPath} was not written because it could not be inspected (${errorCodeOf(error)}) — `
        + `check its permissions, then re-run the install`,
    };
  }

  if (stats.isFile()) {
    return { usable: true };
  }

  if (stats.isSymbolicLink()) {
    const linkTarget = await readlink(destination).catch(() => null);
    const where = linkTarget === null ? "" : ` (-> ${linkTarget})`;
    return {
      usable: false,
      warning: `${displayPath} was not written because it is a symlink${where}; keryx will not write `
        + `through it — replace it with a regular file to let keryx manage it, or update whatever the `
        + `link points at yourself`,
    };
  }

  return {
    usable: false,
    warning: `${displayPath} was not written because it is not a regular file (a directory, FIFO, or `
      + `similar); keryx will not overwrite it — delete or rename it, then re-run the install`,
  };
}

function contractSourcePath(fileName: string): string {
  const directPath = fileURLToPath(new URL(`./contracts/${fileName}`, import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  const packagedSourcePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "gdskills",
    "contracts",
    fileName,
  );
  if (existsSync(packagedSourcePath)) {
    return packagedSourcePath;
  }

  return directPath;
}

function bundledSharedSourcePath(): string {
  const directPath = fileURLToPath(new URL("./bundled/skills/shared", import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  const packagedSourcePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "gdskills",
    "bundled",
    "skills",
    "shared",
  );
  if (existsSync(packagedSourcePath)) {
    return packagedSourcePath;
  }

  return directPath;
}

export function bundledRulesSourcePath(): string {
  const directPath = fileURLToPath(new URL("./bundled/rules/core", import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  const packagedSourcePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "gdskills",
    "bundled",
    "rules",
    "core",
  );
  if (existsSync(packagedSourcePath)) {
    return packagedSourcePath;
  }

  return directPath;
}
