import { readdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { isPathInside, pathExists, toPosix, withFileLock, writeFileAtomic } from "../lib/fs";
import { readJsonFile, readJsonFileOr } from "../lib/json";
import { BUNDLED_GDSKILLS } from "./catalog";
import type { ProjectSkillRegistryEntry } from "./project-skills";

/**
 * `keryx skills remove <module>/<name>` — the inverse of `createProjectSkill`
 * (`keryx skills create`, and `keryx skills import` which goes through it).
 *
 * A project skill lives in four places, and before this command existed each
 * had to be cleaned by hand:
 *
 *   1. the package directory `.metaproject/project-skills/<module>/<name>/`;
 *   2. its entry in `modules.gdskills.projectSkillRegistry` (metaproject.json);
 *   3. its row between the `gdskills:project-skills` markers in
 *      `.metaproject/skills/catalog.md`;
 *   4. its verification report under `.metaproject/data/gdskills/reports/`
 *      (written later, by `keryx skills verify`, so often absent).
 *
 * Deliberately NOT removed, because none of them belongs to one skill alone or
 * is recorded as its property: rules an import copied into `.metaproject/rules/`
 * (other skills cite them), runtime exports under `.metaproject/runtime/skills/`
 * (keyed by a runtime name, written by `keryx skills export`), and learning
 * proposals under `.metaproject/data/gdskills/proposals/` (an audit trail).
 */

export type RemovedPartKind = "registry" | "catalog" | "package" | "module-directory" | "report";

export type RemovedPartStatus = "removed" | "would-remove" | "absent";

export type RemovedPart = {
  part: RemovedPartKind;
  /** Project-relative, posix. */
  path: string;
  status: RemovedPartStatus;
};

export type RemoveProjectSkillOptions = {
  /** `<module>/<name>`, or the package path `.metaproject/project-skills/<module>/<name>`. */
  skill: string;
  dryRun?: boolean | undefined;
};

export type RemoveProjectSkillResult = {
  module: string;
  name: string;
  dryRun: boolean;
  /** In the order they are removed. An `absent` part was already gone; it is not an error. */
  parts: RemovedPart[];
};

type MetaprojectManifest = {
  modules?: {
    gdskills?: {
      projectSkillRegistry?: ProjectSkillRegistryEntry[];
    };
  };
};

const LABEL = "keryx skills remove";
const PROJECT_SKILLS_DIR = ".metaproject/project-skills";
const MANIFEST_PATH = ".metaproject/metaproject.json";
const CATALOG_PATH = ".metaproject/skills/catalog.md";
const REPORTS_DIR = ".metaproject/data/gdskills/reports";
const CATALOG_START = "<!-- gdskills:project-skills:start -->";
const CATALOG_END = "<!-- gdskills:project-skills:end -->";
/** The row `updateSkillsCatalog` (project-skills.ts) renders for an empty registry. */
const CATALOG_EMPTY_ROW = "| _none_ | _none_ | _none_ | - |";
/** One path segment, and nothing that can climb out of it. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Target = {
  module: string;
  name: string;
  /** Project-relative posix path of the package directory. */
  packagePath: string;
  /** False for a package directory with no registry entry (a half-cleaned state). */
  registered: boolean;
};

export async function removeProjectSkill(
  projectRoot: string,
  options: RemoveProjectSkillOptions,
): Promise<RemoveProjectSkillResult> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: keryx init");
  }

  const dryRun = options.dryRun === true;
  // Resolved — and every refusal raised — before the lock is taken, so a
  // refused or previewed removal writes nothing at all, lock directory included.
  const target = await resolveTarget(projectRoot, options.skill);

  const parts = dryRun
    ? await removeParts(projectRoot, target, false)
    : // The same lock `createProjectSkill` holds while it writes these files.
      await withFileLock(path.join(metaprojectRoot, "data", "gdskills", "project-skills.lock"), () =>
        removeParts(projectRoot, target, true),
      );

  return { module: target.module, name: target.name, dryRun, parts };
}

async function readRegistry(projectRoot: string): Promise<ProjectSkillRegistryEntry[]> {
  const manifestPath = path.join(projectRoot, MANIFEST_PATH);
  if (!(await pathExists(manifestPath))) {
    return [];
  }
  // Not `readJsonFileOr`: a manifest that does not parse must stop a removal,
  // not read as "nothing registered" and then be overwritten.
  const manifest = await readJsonFile<MetaprojectManifest>(manifestPath);
  const registry = manifest?.modules?.gdskills?.projectSkillRegistry;
  return Array.isArray(registry) ? registry : [];
}

async function resolveTarget(projectRoot: string, input: string): Promise<Target> {
  const key = normalizeSkillKey(input);
  const registry = await readRegistry(projectRoot);
  const entry = registry.find((candidate) => `${candidate.module}/${candidate.name}` === key);

  if (entry) {
    const packagePath = toPosix(entry.path).replace(/\/+$/, "");
    const absolute = path.resolve(projectRoot, packagePath);
    const skillsRoot = path.join(projectRoot, PROJECT_SKILLS_DIR);
    // The registry is a hand-editable file and this path is about to be
    // deleted recursively: it is trusted only inside project-skills.
    if (absolute === path.resolve(skillsRoot) || !isPathInside(skillsRoot, absolute)) {
      throw new Error(
        `${LABEL}: the registry entry for ${key} points at ${JSON.stringify(entry.path)}, which is outside ${PROJECT_SKILLS_DIR}/. ` +
          `Refusing to delete it. Fix the entry's "path" in ${MANIFEST_PATH} and retry.`,
      );
    }
    return { module: entry.module, name: entry.name, packagePath, registered: true };
  }

  const segments = key.split("/");
  const [moduleName, skillName] = segments;
  const addressable =
    segments.length === 2 && moduleName !== undefined && skillName !== undefined && SEGMENT.test(moduleName) && SEGMENT.test(skillName);

  // A package directory with no registry entry is what an interrupted removal
  // (the entry goes first) or a hand-edited manifest leaves behind. Everything
  // under project-skills is a project skill, so it is still this command's to remove.
  if (addressable) {
    const packagePath = `${PROJECT_SKILLS_DIR}/${moduleName}/${skillName}`;
    if (await pathExists(path.join(projectRoot, packagePath))) {
      return { module: moduleName, name: skillName, packagePath, registered: false };
    }
  }

  const bundled = BUNDLED_GDSKILLS.find((skill) => skill.name === key || `${skill.category}/${skill.name}` === key);
  const installedBundled = addressable && (await pathExists(path.join(projectRoot, ".metaproject", "skills", "gdskills", moduleName, skillName)));
  if (bundled || installedBundled) {
    throw new Error(
      `${LABEL}: ${input} is a bundled skill, not a project skill. ` +
        "Bundled skills are managed by `keryx skills install` / `keryx skills uninstall`; " +
        "this command removes only what `keryx skills create` or `keryx skills import` registered.",
    );
  }

  const registered = registry.map((candidate) => `${candidate.module}/${candidate.name}`);
  throw new Error(
    `${LABEL}: project skill not found: ${input}. ` +
      (registered.length > 0
        ? `Pass <module>/<name>. Registered: ${registered.join(", ")}.`
        : "No project skills are registered (`keryx skills list`)."),
  );
}

/** `review/x`, `./.metaproject/project-skills/review/x/` and `…/review/x/SKILL.md` all name `review/x`. */
function normalizeSkillKey(input: string): string {
  const normalized = toPosix(input.trim())
    .replace(/^\.\//, "")
    .replace(/\/SKILL\.md$/i, "")
    .replace(/\/+$/, "");
  return normalized.startsWith(`${PROJECT_SKILLS_DIR}/`) ? normalized.slice(PROJECT_SKILLS_DIR.length + 1) : normalized;
}

/**
 * One pass for both modes: `apply: false` reports what is there, `apply: true`
 * reports the same rows while removing them, so a dry run cannot describe a
 * removal that the real run would not perform.
 *
 * The registry entry goes first. It is the ownership record, and an interrupted
 * run then leaves a package directory with no entry — a state `resolveTarget`
 * still accepts, so the command can simply be run again.
 */
async function removeParts(projectRoot: string, target: Target, apply: boolean): Promise<RemovedPart[]> {
  const present: RemovedPartStatus = apply ? "removed" : "would-remove";
  const parts: RemovedPart[] = [];

  parts.push({
    part: "registry",
    path: MANIFEST_PATH,
    status: (await removeRegistryEntry(projectRoot, target, apply)) ? present : "absent",
  });

  parts.push({
    part: "catalog",
    path: CATALOG_PATH,
    status: (await removeCatalogRow(projectRoot, target, apply)) ? present : "absent",
  });

  const packageRoot = path.join(projectRoot, target.packagePath);
  const packageExists = await pathExists(packageRoot);
  if (packageExists && apply) {
    await rm(packageRoot, { recursive: true, force: true });
  }
  parts.push({ part: "package", path: target.packagePath, status: packageExists ? present : "absent" });

  // `createProjectSkill` made the module directory too. It is removed only when
  // this skill was the last thing in it, and listed only when that is the case.
  const moduleRoot = path.dirname(packageRoot);
  if (path.resolve(moduleRoot) !== path.resolve(projectRoot, PROJECT_SKILLS_DIR) && (await pathExists(moduleRoot))) {
    const others = (await readdir(moduleRoot)).filter((name) => name !== path.basename(packageRoot));
    if (others.length === 0) {
      if (apply) {
        await rmdir(moduleRoot);
      }
      parts.push({ part: "module-directory", path: toPosix(path.relative(projectRoot, moduleRoot)), status: present });
    }
  }

  const reports = await findReports(projectRoot, target);
  for (const report of reports.existing) {
    if (apply) {
      await rm(path.join(projectRoot, report), { force: true });
    }
    parts.push({ part: "report", path: report, status: present });
  }
  if (reports.existing.length === 0) {
    parts.push({ part: "report", path: reports.conventional, status: "absent" });
  }

  return parts;
}

function isTargetEntry(entry: ProjectSkillRegistryEntry, target: Target): boolean {
  return (entry.module === target.module && entry.name === target.name) || toPosix(entry.path ?? "").replace(/\/+$/, "") === target.packagePath;
}

async function removeRegistryEntry(projectRoot: string, target: Target, apply: boolean): Promise<boolean> {
  const manifestPath = path.join(projectRoot, MANIFEST_PATH);
  if (!(await pathExists(manifestPath))) {
    return false;
  }
  const manifest = await readJsonFile<MetaprojectManifest>(manifestPath);
  const gdskills = manifest?.modules?.gdskills;
  const registry = gdskills?.projectSkillRegistry;
  if (!gdskills || !Array.isArray(registry)) {
    return false;
  }
  const kept = registry.filter((entry) => !isTargetEntry(entry, target));
  if (kept.length === registry.length) {
    return false;
  }
  if (apply) {
    gdskills.projectSkillRegistry = kept;
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return true;
}

/**
 * Drop this skill's row from the generated section, and nothing else in the file.
 *
 * `updateSkillsCatalog` would regenerate the whole section from the registry;
 * that also CREATES the section (and the file) when absent, which is not a
 * removal's business, and it cannot say whether a row was there to remove.
 */
async function removeCatalogRow(projectRoot: string, target: Target, apply: boolean): Promise<boolean> {
  const catalogPath = path.join(projectRoot, CATALOG_PATH);
  if (!(await pathExists(catalogPath))) {
    return false;
  }
  const lines = (await readFile(catalogPath, "utf8")).split("\n");
  const start = lines.findIndex((line) => line.trim() === CATALOG_START);
  const end = lines.findIndex((line, index) => index > start && line.trim() === CATALOG_END);
  if (start < 0 || end < 0) {
    return false;
  }

  const entryCell = `${target.packagePath}/SKILL.md`;
  const isTargetRow = (line: string): boolean => {
    if (!line.trimStart().startsWith("|")) return false;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return (cells[0] === target.module && cells[1] === target.name) || cells[3] === entryCell;
  };

  const section = lines.slice(start + 1, end);
  const kept = section.filter((line) => !isTargetRow(line));
  if (kept.length === section.length) {
    return false;
  }

  if (apply) {
    // Header and separator are the first two table lines; a table left with
    // only those gets the placeholder row an empty registry renders.
    const tableLines = kept.filter((line) => line.trimStart().startsWith("|"));
    if (tableLines.length <= 2) {
      const lastTableLine = kept.reduce((last, line, index) => (line.trimStart().startsWith("|") ? index : last), -1);
      kept.splice(lastTableLine + 1, 0, CATALOG_EMPTY_ROW);
    }
    await writeFileAtomic(catalogPath, [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join("\n"));
  }
  return true;
}

/**
 * `keryx skills verify` names its report `<module>-<name>-verification.json`,
 * where `<module>` is the SKILL.md `Module:` header when there is one — which
 * can differ from the registry's. So the conventional name is checked, and so
 * is every report that says, in its own body, that it is about this skill.
 */
async function findReports(projectRoot: string, target: Target): Promise<{ existing: string[]; conventional: string }> {
  const conventional = `${REPORTS_DIR}/${target.module}-${target.name}-verification.json`;
  const reportsRoot = path.join(projectRoot, REPORTS_DIR);
  const existing = new Set<string>();
  if (await pathExists(path.join(projectRoot, conventional))) {
    existing.add(conventional);
  }
  if (await pathExists(reportsRoot)) {
    const entries = await readdir(reportsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith("-verification.json")) continue;
      const report = await readJsonFileOr<{ module?: unknown; name?: unknown; skillPath?: unknown } | null>(
        path.join(reportsRoot, entry.name),
        null,
      );
      if (report === null || typeof report !== "object") continue;
      const samePath = typeof report.skillPath === "string" && toPosix(report.skillPath).replace(/\/+$/, "") === target.packagePath;
      const sameKey = report.module === target.module && report.name === target.name;
      if (samePath || sameKey) {
        existing.add(`${REPORTS_DIR}/${entry.name}`);
      }
    }
  }
  return { existing: [...existing].sort(), conventional };
}

const PART_LABEL: Record<RemovedPartKind, string> = {
  registry: "registry entry",
  catalog: "catalog row",
  package: "package directory",
  "module-directory": "module directory",
  report: "verification report",
};

const STATUS_LABEL: Record<RemovedPartStatus, string> = {
  removed: "removed",
  "would-remove": "would remove",
  absent: "absent",
};

export function renderRemoveProjectSkill(result: RemoveProjectSkillResult): string {
  const lines = [`${result.dryRun ? "Would remove" : "Removed"} project skill: ${result.module}/${result.name}`];
  for (const part of result.parts) {
    lines.push(`- ${STATUS_LABEL[part.status]}: ${PART_LABEL[part.part]} — ${part.path}`);
  }
  if (result.dryRun) {
    lines.push("Dry run: nothing was changed.");
  }
  return lines.join("\n");
}

const REMOVE_FLAGS = new Set(["--dry-run", "--json"]);

/** `args[0]` is the subcommand token (`remove`), as the skills router passes it. */
export async function runSkillsRemoveCommand(args: string[], projectRoot: string = process.cwd()): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printSkillsRemoveHelp();
    return;
  }
  const rest = args.slice(1);
  // A deleting command does not guess at a flag it does not know: `--force`
  // or `--all` silently ignored would read as having been honoured.
  const unknown = rest.find((arg) => arg.startsWith("-") && !REMOVE_FLAGS.has(arg));
  if (unknown !== undefined) {
    throw new Error(`${LABEL}: Unknown option: ${unknown}. Usage: keryx skills remove <module>/<name> [--dry-run] [--json]`);
  }
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  const skill = positional[0];
  if (skill === undefined) {
    printSkillsRemoveHelp();
    throw new Error("Usage: keryx skills remove <module>/<name> [--dry-run] [--json]");
  }
  if (positional.length > 1) {
    throw new Error(`${LABEL}: removes one skill per call; got ${positional.join(", ")}.`);
  }

  const result = await removeProjectSkill(projectRoot, { skill, dryRun: rest.includes("--dry-run") });
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderRemoveProjectSkill(result));
}

export function printSkillsRemoveHelp(): void {
  console.log(`keryx skills remove

Remove a project skill: the inverse of \`keryx skills create\` and
\`keryx skills import\`.

Usage:
  keryx skills remove <module>/<name> [--dry-run] [--json]

Removes, and lists each as removed or absent:
  - the package directory .metaproject/project-skills/<module>/<name>/
    (and the <module>/ directory when this was the last skill in it)
  - the projectSkillRegistry entry in .metaproject/metaproject.json
  - the row in the Project Skills section of .metaproject/skills/catalog.md
  - the verification report under .metaproject/data/gdskills/reports/

A part that is already gone is reported as absent, not as an error, so a skill
half-removed by hand can be finished with this command.

--dry-run:
  print what would be removed and change nothing.

--json:
  print { module, name, dryRun, parts: [{ part, path, status }] }, where status
  is removed | would-remove | absent.

Refused:
  - a bundled skill. Those are managed by \`keryx skills install\` and
    \`keryx skills uninstall\`. A project skill imported over a bundled name
    (\`import --force\`) is a project skill and is removable.
  - a name that is not a project skill. Names are listed by \`keryx skills list\`.

Not removed: rules an import copied into .metaproject/rules/ (other skills may
cite them), runtime exports under .metaproject/runtime/skills/, and learning
proposals under .metaproject/data/gdskills/proposals/.

Examples:
  keryx skills remove review/review-house-api --dry-run
  keryx skills remove review/review-house-api
  keryx skills remove quality/verifier --json
`);
}
