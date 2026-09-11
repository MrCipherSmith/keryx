import { cp, copyFile, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../lib/fs";
import { CONTRACTS, contractPath } from "./contracts";
import {
  type GdskillsProfile,
  getBundledSkillsForProfile,
  renderBundledSkill,
  renderGdskillsCatalog,
  renderGdskillsManifest,
} from "./catalog";
import { RETIRED_RULE_SIZE_CAP_BYTES, RETIRED_RULES, type RetiredRuleOutcome } from "./retired-rules";

export type InstallGdskillsResult = {
  profile: GdskillsProfile;
  installedSkills: number;
  skillsRoot: string;
  catalogPath: string;
  manifestPath: string;
  /**
   * Human-readable notices surfaced from the install, same convention as
   * `createProjectSkill`'s result (`src/gdskills/project-skills.ts`): plain
   * strings a caller can print under a "Warnings:" heading. Currently only
   * populated by retired-rule cleanup — see `retired-rules.ts`.
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

  await installBundledSharedSkills(skillsRoot);
  const retiredRuleOutcomes = await installBundledRules(metaprojectRoot);

  const catalogPath = path.join(metaprojectRoot, "skills", "catalog.md");
  await writeFile(catalogPath, await preserveProjectSkillsSection(catalogPath, renderGdskillsCatalog(profile)), "utf8");

  const manifestPath = path.join(metaprojectRoot, "modules", "gdskills.md");
  await writeFile(manifestPath, renderGdskillsManifest(profile), "utf8");

  await installContracts(contractsRoot);

  const warnings = retiredRuleOutcomes
    .map(retiredRuleWarning)
    .filter((warning): warning is string => warning !== null);

  return {
    profile,
    installedSkills: skills.length,
    skillsRoot,
    catalogPath,
    manifestPath,
    warnings,
  };
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
async function removeUnmodifiedRetiredRules(rulesTarget: string): Promise<RetiredRuleOutcome[]> {
  const outcomes: RetiredRuleOutcome[] = [];
  for (const retired of RETIRED_RULES) {
    const installedPath = path.join(rulesTarget, retired.fileName);
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

      const content = await readFile(installedPath);
      const hash = createHash("sha256").update(normalizeRetiredRuleContent(content)).digest("hex");
      if (retired.shippedSha256.includes(hash)) {
        await unlink(installedPath);
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
      // Anything else (EACCES on an unreadable file, a race where the
      // entry disappears between lstat and readFile/unlink, etc.): keep
      // the file, warn, and move on to the next retired name. Cleanup of
      // one entry must never abort the rest of installGdskills.
      outcomes.push({
        fileName: retired.fileName,
        action: "kept-error",
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
 */
function normalizeRetiredRuleContent(content: Buffer): string {
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
function retiredRuleWarning(outcome: RetiredRuleOutcome): string | null {
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
      return `${prefix}; kept because it could not be read (${outcome.errorCode}) — inspect it, then delete or rename it if appropriate`;
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
