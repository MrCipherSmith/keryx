import { cp, copyFile, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../lib/fs";
import { CONTRACTS, contractPath } from "./contracts";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";
import {
  BUNDLED_GDSKILLS,
  type GdskillsProfile,
  getBundledSkillsForProfile,
  renderBundledSkill,
  renderGdskillsCatalog,
  renderGdskillsManifest,
} from "./catalog";
import {
  RETIRED_RULE_SIZE_CAP_BYTES,
  RETIRED_RULES,
  type RetiredRuleFailureStage,
  type RetiredRuleOutcome,
} from "./retired-rules";

export type InstallGdskillsResult = {
  profile: GdskillsProfile;
  installedSkills: number;
  skillsRoot: string;
  catalogPath: string;
  manifestPath: string;
  /**
   * Human-readable notices surfaced from the install, same convention as
   * `createProjectSkill`'s result (`src/gdskills/project-skills.ts`): plain
   * strings a caller can print under a "Warnings:" heading. Populated by
   * retired-rule cleanup (see `retired-rules.ts`) and by stale per-runtime
   * build cleanup when a stale build could not be removed (see
   * `removeStaleRuntimeBuilds`).
   */
  warnings: string[];
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

  await Promise.all([
    mkdir(skillsRoot, { recursive: true }),
    mkdir(contractsRoot, { recursive: true }),
    mkdir(projectSkillsRoot, { recursive: true }),
    mkdir(path.join(metaprojectRoot, "jobs"), { recursive: true }),
    mkdir(path.join(metaprojectRoot, "modules"), { recursive: true }),
    ...(options.createDataDirs === false ? [] : [
      mkdir(path.join(dataRoot, "artifacts"), { recursive: true }),
      mkdir(path.join(dataRoot, "reports"), { recursive: true }),
      mkdir(path.join(dataRoot, "proposals"), { recursive: true }),
    ]),
  ]);

  for (const skillEntry of skills) {
    const skillDir = path.join(skillsRoot, skillEntry.category, skillEntry.name);
    await mkdir(skillDir, { recursive: true });
    const bundledSkillPath = bundledSkillSourcePath(skillEntry.category, skillEntry.name);
    if (existsSync(bundledSkillPath)) {
      await cp(bundledSkillPath, skillDir, { recursive: true, force: true });
    } else {
      await writeFile(path.join(skillDir, "SKILL.md"), renderBundledSkill(skillEntry), "utf8");
    }
  }

  const staleBuildOutcomes = await removeStaleRuntimeBuilds(skillsRoot);
  await installBundledSharedSkills(skillsRoot);
  const retiredRuleOutcomes = await installBundledRules(metaprojectRoot);

  const catalogPath = path.join(metaprojectRoot, "skills", "catalog.md");
  await writeFile(catalogPath, await preserveProjectSkillsSection(catalogPath, renderGdskillsCatalog(profile)), "utf8");

  const manifestPath = path.join(metaprojectRoot, "modules", "gdskills.md");
  await writeFile(manifestPath, renderGdskillsManifest(profile), "utf8");

  await installContracts(contractsRoot);

  const projectRoot = path.dirname(metaprojectRoot);
  const warnings = [
    ...retiredRuleOutcomes.map(retiredRuleWarning),
    ...staleBuildOutcomes.map((outcome) => staleRuntimeBuildWarning(outcome, projectRoot)),
  ].filter((warning): warning is string => warning !== null);

  return {
    profile,
    installedSkills: skills.length,
    skillsRoot,
    catalogPath,
    manifestPath,
    warnings,
  };
}

/** `SKILL.codex.md`, `SKILL.cursor.md`, … — every per-runtime build name. */
const RUNTIME_BUILD_FILE_NAMES: readonly string[] = HARNESS_SKILL_RUNTIMES
  .filter((runtime) => runtime !== "claude")
  .map((runtime) => skillBuildFileName(runtime));

export type StaleRuntimeBuildOutcome =
  | { path: string; action: "removed" }
  | { path: string; action: "kept-not-regular-file" }
  | { path: string; action: "kept-error"; errorCode: string };

/**
 * Remove per-runtime builds (`SKILL.<runtime>.md`) the bundle no longer ships
 * from the installed keryx-managed skill directories.
 *
 * `installGdskills` copies each bundled skill directory over the installed one
 * with `cp(force)`, which overwrites but never deletes. A project installed
 * before flow 257 therefore keeps a `SKILL.codex.md` (etc.) that the bundle
 * dropped because it was a byte-identical copy of `SKILL.md` — and
 * `resolveSkillBuild` prefers an existing `SKILL.<runtime>.md`, so that stale
 * copy would win every later `--runtime` export over the current `SKILL.md`.
 *
 * Scope is deliberately narrow:
 *   - only directories of catalogued bundled skills
 *     (`<skillsRoot>/<category>/<name>/`), never `project-skills/`, `shared/`,
 *     or anything else under the tree;
 *   - only the per-runtime build file names, never `SKILL.md`, companions such
 *     as `SKILL.detail.md`, or any other file;
 *   - only names the bundle does not ship for that skill — a build it still
 *     ships was just refreshed by the copy and is left in place.
 *
 * These directories are keryx-managed: the copy above overwrites their
 * `SKILL.md` unconditionally, so a stale build is removed without a content
 * check, the same way. Following the retired-rule cleanup, each entry is
 * `lstat`ed (a symlink or other non-regular file is kept, never followed or
 * read), and no single entry's failure escapes the loop — it becomes an
 * outcome that `staleRuntimeBuildWarning` turns into a warning.
 */
export async function removeStaleRuntimeBuilds(
  skillsRoot: string,
  fsOps: { unlink: (target: string) => Promise<void> } = { unlink },
): Promise<StaleRuntimeBuildOutcome[]> {
  const outcomes: StaleRuntimeBuildOutcome[] = [];
  for (const skillEntry of BUNDLED_GDSKILLS) {
    const bundledDir = bundledSkillSourcePath(skillEntry.category, skillEntry.name);
    const installedDir = path.join(skillsRoot, skillEntry.category, skillEntry.name);
    for (const buildName of RUNTIME_BUILD_FILE_NAMES) {
      // A skill rendered from the catalogue (no bundled directory) ships no
      // per-runtime build, so every such name in its installed dir is stale.
      if (existsSync(path.join(bundledDir, buildName))) continue;
      const installedPath = path.join(installedDir, buildName);
      try {
        const stats = await lstat(installedPath);
        if (!stats.isFile()) {
          outcomes.push({ path: installedPath, action: "kept-not-regular-file" });
          continue;
        }
        await fsOps.unlink(installedPath);
        outcomes.push({ path: installedPath, action: "removed" });
      } catch (error) {
        if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          // Nothing there — the steady state, and the case for every skill
          // this profile did not install.
          continue;
        }
        outcomes.push({
          path: installedPath,
          action: "kept-error",
          errorCode: isErrnoException(error) && error.code ? error.code : "UNKNOWN",
        });
      }
    }
  }
  return outcomes;
}

/**
 * Notice for one stale-build outcome, or `null` when it was removed (nothing
 * to tell the operator). `projectRoot` only shortens the path in the message.
 */
export function staleRuntimeBuildWarning(outcome: StaleRuntimeBuildOutcome, projectRoot: string): string | null {
  if (outcome.action === "removed") {
    return null;
  }
  const shown = path.relative(projectRoot, outcome.path).split(path.sep).join("/");
  const prefix = `${shown} is a per-runtime build keryx no longer ships (that runtime now reads SKILL.md), and a runtime export would still prefer it over SKILL.md`;
  switch (outcome.action) {
    case "kept-not-regular-file":
      return `${prefix}; kept because it is not a regular file (a symlink, directory, or similar) — keryx will not read or remove it; delete it yourself if appropriate`;
    case "kept-error":
      return `${prefix}; it could not be removed (${outcome.errorCode}) — delete it by hand`;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled stale runtime build outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function installBundledSharedSkills(skillsRoot: string): Promise<void> {
  const sharedSource = bundledSharedSourcePath();
  if (!existsSync(sharedSource)) {
    return;
  }
  await cp(sharedSource, path.join(skillsRoot, "shared"), { recursive: true, force: true });
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
 */
async function installBundledRules(metaprojectRoot: string): Promise<RetiredRuleOutcome[]> {
  const rulesSource = bundledRulesSourcePath();
  const rulesTarget = path.join(metaprojectRoot, "rules", "core");
  if (!existsSync(rulesSource)) {
    return [];
  }
  await cp(rulesSource, rulesTarget, { recursive: true, force: true });
  return removeUnmodifiedRetiredRules(rulesTarget);
}

/**
 * For each name RETIRED_RULES tracks, decide what to do with whatever sits
 * at that path in the installed project — without ever letting a hostile or
 * merely unusual entry (a directory, symlink, FIFO, socket, device, huge
 * file, or permission-denied file) abort the rest of `installGdskills`.
 *
 * `.metaproject/rules/core` is git-tracked, so a project's repo — not just
 * the project's own edits — can plant any of these at a retired name (round-1
 * finding S-001). The rule this function follows: `lstat` first and never
 * follow a symlink or read anything that is not a plain regular file; cap
 * the size of what it will read; and let no single entry's failure escape
 * this loop — every failure becomes a warning instead.
 */
export async function removeUnmodifiedRetiredRules(
  rulesTarget: string,
  // Injectable so the unlink-failure branch can be tested on every platform:
  // a read-only directory is not a portable way to make only this unlink fail,
  // because on Linux Bun's `cp({ force: true })` unlinks every destination
  // first and aborts the bulk copy before this function runs.
  fsOps: { unlink: (target: string) => Promise<void> } = { unlink },
): Promise<RetiredRuleOutcome[]> {
  const outcomes: RetiredRuleOutcome[] = [];
  for (const retired of RETIRED_RULES) {
    const installedPath = path.join(rulesTarget, retired.fileName);
    // Updated right before each step so the catch block below can name
    // which one actually failed (round-2 finding L-008).
    let stage: RetiredRuleFailureStage = "lstat";
    try {
      const stats = await lstat(installedPath);

      // Symlinks, directories, FIFOs, sockets, and devices are all rejected
      // here. `lstat` never follows a symlink, so a link at a retired name
      // is judged (and, if kept, left alone) without ever touching its
      // target — reading through it is the hazard, not the link itself.
      if (!stats.isFile()) {
        outcomes.push({ fileName: retired.fileName, action: "kept-not-regular-file" });
        continue;
      }

      // Bound the read before doing it: a regular file far larger than
      // anything keryx ever shipped under this name is not a plausible
      // untouched leftover, so there is no reason to read all of it.
      if (stats.size > RETIRED_RULE_SIZE_CAP_BYTES) {
        outcomes.push({ fileName: retired.fileName, action: "kept-oversized", sizeBytes: stats.size });
        continue;
      }

      stage = "read";
      const content = await readFile(installedPath);
      const hash = createHash("sha256").update(normalizeRetiredRuleContent(content)).digest("hex");
      if (retired.shippedSha256.includes(hash)) {
        stage = "unlink";
        await fsOps.unlink(installedPath);
        outcomes.push({ fileName: retired.fileName, action: "removed" });
      } else {
        outcomes.push({ fileName: retired.fileName, action: "kept-modified" });
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        // Nothing at this retired name — the steady state once every
        // installation has caught up. Not an outcome, not a warning.
        continue;
      }
      // Anything else (EACCES on an unreadable file, a read-only
      // directory blocking the unlink of a confirmed-unmodified copy, a
      // race where the entry disappears between lstat and
      // readFile/unlink, etc.): keep the file, warn, and move on to the
      // next retired name. Cleanup of one entry must never abort the rest
      // of installGdskills. `stage` records which step was in flight, so
      // the warning below can tell a read failure (the file's status is
      // still unknown) apart from an unlink failure (the file was already
      // confirmed as an unmodified shipped copy — only its removal failed).
      outcomes.push({
        fileName: retired.fileName,
        action: "kept-error",
        stage,
        errorCode: isErrnoException(error) && error.code ? error.code : "UNKNOWN",
      });
    }
  }
  return outcomes;
}

/**
 * Decode as UTF-8, strip one leading U+FEFF byte-order mark, and normalise
 * `\r\n` to `\n` before hashing. `RETIRED_RULES[].shippedSha256` records
 * hashes of content normalised this same way (the files themselves are
 * shipped LF, BOM-less) — without this, an unmodified copy checked out with
 * CRLF line endings (e.g. Windows `core.autocrlf=true`) or carrying a BOM
 * would never match and would be kept + warned as "modified" forever
 * (round-1 finding L-001).
 *
 * Exported so `install.test.ts` can hash fixtures the same way the
 * installer does, instead of maintaining its own copy of this function
 * that could silently drift from it (round-2 finding T-008).
 */
export function normalizeRetiredRuleContent(content: Buffer): string {
  let text = content.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text.replace(/\r\n/g, "\n");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Human-readable notice for one retired-rule outcome, or `null` for
 * "removed" (nothing to tell the operator). Each kept-* case gets its own
 * wording naming why the file is no longer shipped (`RETIRED_RULES[].reason`)
 * and what to do about it, rather than one generic "modified" message that
 * repeats forever with no remedy (round-1 finding L-002).
 */
export function retiredRuleWarning(outcome: RetiredRuleOutcome): string | null {
  if (outcome.action === "removed") {
    return null;
  }
  const reason = RETIRED_RULES.find((retired) => retired.fileName === outcome.fileName)?.reason
    ?? "no longer shipped by keryx";
  const prefix = `${outcome.fileName} is no longer shipped by keryx (${reason})`;
  switch (outcome.action) {
    case "kept-modified":
      return `${prefix}; kept because it differs from every shipped version — delete it, or rename it if you still rely on it`;
    case "kept-not-regular-file":
      return `${prefix}; kept because it is not a regular file (a symlink, directory, or similar) — keryx will not read or remove it; delete or rename it yourself if appropriate`;
    case "kept-oversized":
      return `${prefix}; kept because it is ${outcome.sizeBytes} bytes, far larger than any version keryx ever shipped under this name — inspect it, then delete or rename it if appropriate`;
    case "kept-error":
      // `lstat`/`read` failures leave the file's status unconfirmed, so
      // they keep the original "could not be read" wording. An `unlink`
      // failure means the file *was* read and hash-matched an unmodified
      // shipped copy — only the removal failed — so it gets its own
      // wording rather than the misleading "could not be read"
      // (round-2 finding L-008).
      return outcome.stage === "unlink"
        ? `${prefix}; matches a shipped version but could not be removed (${outcome.errorCode}) — delete it by hand`
        : `${prefix}; kept because it could not be read (${outcome.errorCode}) — inspect it, then delete or rename it if appropriate`;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled retired rule outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
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
 */
async function installContracts(contractsRoot: string): Promise<void> {
  await Promise.all(
    CONTRACTS.map((contract) =>
      copyFile(
        contract.sourcePath ? contractPath(contract) : contractSourcePath(contract.fileName),
        path.join(contractsRoot, contract.fileName),
      ),
    ),
  );
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

function bundledSkillSourcePath(category: string, skillName: string): string {
  const directPath = fileURLToPath(new URL(`./bundled/skills/${category}/${skillName}`, import.meta.url));
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
    category,
    skillName,
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

function bundledRulesSourcePath(): string {
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
