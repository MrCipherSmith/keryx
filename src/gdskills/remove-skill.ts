import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { removeContained, rmdirIfEmptyContained, writeContained } from "../lib/contained-write";
import { isPathInside, pathExists, toPosix, withFileLock } from "../lib/fs";
import { readJsonFile, readJsonFileOr } from "../lib/json";
import { BUNDLED_GDSKILLS } from "./catalog";
import { isMissingPathError } from "./guarded-fs-ops";
import {
  PROJECT_SKILL_REPORT_SUFFIX,
  PROJECT_SKILL_REPORTS_DIR,
  PROJECT_SKILLS_CATALOG_EMPTY_ROW,
  PROJECT_SKILLS_CATALOG_END,
  PROJECT_SKILLS_CATALOG_PATH,
  PROJECT_SKILLS_CATALOG_START,
  PROJECT_SKILLS_DIR,
  PROJECT_SKILLS_LOCK_PATH,
  PROJECT_SKILLS_MANIFEST_PATH,
  projectSkillReportFileName,
} from "./project-skills";

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
 *
 * The command deletes recursively and is driven by a hand-editable registry, so
 * its reach is fixed (flow 360 review F-001, F-002, F-007):
 *
 *   - the package is always `.metaproject/project-skills/<module>/<name>`, two
 *     plain segments — a registry entry is believed only when its `path` says
 *     exactly that about its own `module` and `name`;
 *   - nothing is deleted through a symlink: every directory above a thing to be
 *     deleted, and the package itself, must be a real directory where its name
 *     says it is. The two files that are rewritten rather than deleted may be
 *     reached through a link, but only to a file inside the project, and the
 *     result then names where the write lands;
 *   - all of that is decided by `planRemoval`, which only reads. A refusal is
 *     raised there, before the first write, so a refused run changes nothing —
 *     and a dry run returns that same plan, so it lists what the real run does.
 */

export type RemovedPartKind = "registry" | "catalog" | "package" | "module-directory" | "report";

export type RemovedPartStatus = "removed" | "would-remove" | "absent";

export type RemovedPart = {
  part: RemovedPartKind;
  /** Project-relative, posix. */
  path: string;
  /** Where a rewritten file really is, when `path` reaches it through a symlink. Project-relative, posix. */
  resolvedPath?: string;
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
      /** Hand-editable, so nothing about an entry's shape is assumed. */
      projectSkillRegistry?: unknown;
    };
  };
};

const LABEL = "keryx skills remove";
/** One path segment, and nothing that can climb out of it. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNCHANGED = "Nothing was changed.";

type Target = {
  module: string;
  name: string;
  /** Always `.metaproject/project-skills/<module>/<name>`. */
  packagePath: string;
};

/** One row of the result, and — when there is something to remove — how. Resolves to false when it turned out to be gone. */
type PlannedPart = {
  part: RemovedPart;
  apply?: () => Promise<boolean>;
};

type Plan = {
  target: Target;
  parts: PlannedPart[];
};

export async function removeProjectSkill(
  projectRoot: string,
  options: RemoveProjectSkillOptions,
): Promise<RemoveProjectSkillResult> {
  if (!(await pathExists(path.join(projectRoot, ".metaproject")))) {
    throw new Error("Metaproject is not initialized. Run: keryx init");
  }

  const dryRun = options.dryRun === true;
  // Planned — and every refusal raised — before the lock is taken, so a
  // refused or previewed removal writes nothing at all, lock directory included.
  const preview = await planRemoval(projectRoot, options.skill);
  if (dryRun) {
    return { module: preview.target.module, name: preview.target.name, dryRun, parts: preview.parts.map((planned) => planned.part) };
  }

  // The same lock `createProjectSkill` holds while it writes these files. The
  // plan is made again under it: what is applied is what is on disk now, not
  // what was there before a concurrent create or remove finished.
  return withFileLock(path.join(projectRoot, PROJECT_SKILLS_LOCK_PATH), async () => {
    const plan = await planRemoval(projectRoot, options.skill);
    const parts: RemovedPart[] = [];
    for (const planned of plan.parts) {
      const removed = planned.apply !== undefined && (await planned.apply());
      parts.push({ ...planned.part, status: removed ? "removed" : "absent" });
    }
    return { module: plan.target.module, name: plan.target.name, dryRun, parts };
  });
}

/**
 * Everything the removal will do, decided without writing anything.
 *
 * The registry entry goes first. It is the ownership record, and a run
 * interrupted after it leaves a package directory with no entry — a state
 * `resolveTarget` still accepts, so the command can simply be run again.
 */
async function planRemoval(projectRoot: string, input: string): Promise<Plan> {
  // Every containment check below is made against where the project really is.
  const root = await realpath(projectRoot);
  const present = (kind: RemovedPartKind, relativePath: string, resolvedPath?: string): RemovedPart => ({
    part: kind,
    path: relativePath,
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
    status: "would-remove",
  });
  const absent = (kind: RemovedPartKind, relativePath: string): PlannedPart => ({ part: { part: kind, path: relativePath, status: "absent" } });
  const write = (relativePath: string, content: string) => async (): Promise<boolean> => {
    await writeContained(root, relativePath, content);
    return true;
  };

  const manifestFile = await locateRewritable(root, PROJECT_SKILLS_MANIFEST_PATH);
  // Not `readJsonFileOr`: a manifest that does not parse must stop a removal,
  // not read as "nothing registered" and then be overwritten.
  const manifest = manifestFile === undefined ? undefined : await readJsonFile<MetaprojectManifest | null>(manifestFile.absolute);
  const gdskills = manifest?.modules?.gdskills;
  const registry: unknown[] = Array.isArray(gdskills?.projectSkillRegistry) ? gdskills.projectSkillRegistry : [];

  const target = await resolveTarget(root, input, registry);
  const key = `${target.module}/${target.name}`;
  const parts: PlannedPart[] = [];

  // 1. Registry entry: the entries with this module AND this name, and no other.
  const keptEntries = registry.filter((entry) => registryKey(entry) !== key);
  if (gdskills !== undefined && manifestFile !== undefined && keptEntries.length < registry.length) {
    gdskills.projectSkillRegistry = keptEntries;
    parts.push({
      part: present("registry", PROJECT_SKILLS_MANIFEST_PATH, manifestFile.resolvedPath),
      apply: write(PROJECT_SKILLS_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`),
    });
  } else {
    parts.push(absent("registry", PROJECT_SKILLS_MANIFEST_PATH));
  }

  // 2. Catalog row.
  const catalogFile = await locateRewritable(root, PROJECT_SKILLS_CATALOG_PATH);
  const catalog = catalogFile === undefined ? undefined : withoutCatalogRow(await readFile(catalogFile.absolute, "utf8"), target);
  if (catalogFile !== undefined && catalog !== undefined) {
    parts.push({
      part: present("catalog", PROJECT_SKILLS_CATALOG_PATH, catalogFile.resolvedPath),
      apply: write(PROJECT_SKILLS_CATALOG_PATH, catalog),
    });
  } else {
    parts.push(absent("catalog", PROJECT_SKILLS_CATALOG_PATH));
  }

  // 3. Package directory, and 4. the module directory `createProjectSkill`
  // made for it — removed only when this skill was the last thing in it, and
  // listed only when that is the case.
  const modulePath = `${PROJECT_SKILLS_DIR}/${target.module}`;
  const moduleExists = await isRealDirectoryChain(root, modulePath);
  const packageStats = moduleExists ? await lstatOrMissing(path.join(root, target.packagePath)) : undefined;
  if (packageStats?.isSymbolicLink()) {
    throw symlinkRefusal(target.packagePath, await linkTarget(path.join(root, target.packagePath)));
  }
  parts.push(
    packageStats === undefined
      ? absent("package", target.packagePath)
      : { part: present("package", target.packagePath), apply: () => removeContained(root, target.packagePath) },
  );
  if (moduleExists && (await readdir(path.join(root, modulePath))).every((name) => name === target.name)) {
    parts.push({ part: present("module-directory", modulePath), apply: () => rmdirIfEmptyContained(root, modulePath) });
  }

  // 5. Verification report(s).
  const reports = await findReports(root, target);
  for (const report of reports.existing) {
    parts.push({ part: present("report", report), apply: () => removeContained(root, report) });
  }
  if (reports.existing.length === 0) {
    parts.push(absent("report", reports.conventional));
  }

  return { target, parts };
}

/** `<module>/<name>` of a registry entry, or undefined for anything that is not an entry. */
function registryKey(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const { module: moduleName, name } = entry as { module?: unknown; name?: unknown };
  return typeof moduleName === "string" && typeof name === "string" ? `${moduleName}/${name}` : undefined;
}

async function resolveTarget(root: string, input: string, registry: readonly unknown[]): Promise<Target> {
  const key = normalizeSkillKey(input);
  const segments = key.split("/");
  const [moduleName, skillName] = segments;
  const addressable =
    segments.length === 2 && moduleName !== undefined && skillName !== undefined && SEGMENT.test(moduleName) && SEGMENT.test(skillName);
  const packagePath = `${PROJECT_SKILLS_DIR}/${key}`;

  const registered = registry.filter((entry) => registryKey(entry) === key);
  for (const entry of registered) {
    // The registry is a hand-editable file, and the entry's `module` and `name`
    // are about to name a directory to delete recursively and a report file:
    // they are two plain segments, or the entry is not acted on (F-007).
    if (!addressable) {
      throw new Error(
        `${LABEL}: the registry entry ${JSON.stringify(key)} is not a <module>/<name> pair of plain path segments. ` +
          `Refusing to remove anything for it. Fix or delete the entry in ${PROJECT_SKILLS_MANIFEST_PATH} by hand. ${UNCHANGED}`,
      );
    }
    // …and its `path` is believed only when it names that same pair's own
    // package directory. Anything else — the module directory, another skill's
    // package, a directory outside project-skills — is somebody else's (F-002).
    const recorded = (entry as { path?: unknown }).path;
    if (typeof recorded !== "string" || toPosix(recorded).replace(/\/+$/, "") !== packagePath) {
      throw new Error(
        `${LABEL}: the registry entry for ${key} has "path": ${JSON.stringify(recorded)}, not its own package directory ${packagePath}. ` +
          `Refusing to remove anything for it. Fix the entry's "path" in ${PROJECT_SKILLS_MANIFEST_PATH} and retry. ${UNCHANGED}`,
      );
    }
  }
  if (registered.length > 0 && addressable) {
    return { module: moduleName, name: skillName, packagePath };
  }

  // A package directory with no registry entry is what an interrupted removal
  // (the entry goes first) or a hand-edited manifest leaves behind. Everything
  // under project-skills is a project skill, so it is still this command's to remove.
  if (addressable && (await pathExists(path.join(root, packagePath)))) {
    return { module: moduleName, name: skillName, packagePath };
  }

  const bundled = BUNDLED_GDSKILLS.find((skill) => skill.name === key || `${skill.category}/${skill.name}` === key);
  const installedBundled = addressable && (await pathExists(path.join(root, ".metaproject", "skills", "gdskills", moduleName, skillName)));
  if (bundled || installedBundled) {
    throw new Error(
      `${LABEL}: ${input} is a bundled skill, not a project skill. ` +
        "Bundled skills are managed by `keryx skills install` / `keryx skills uninstall`; " +
        "this command removes only what `keryx skills create` or `keryx skills import` registered.",
    );
  }

  const known = registry.map(registryKey).filter((entry): entry is string => entry !== undefined);
  throw new Error(
    `${LABEL}: project skill not found: ${input}. ` +
      (known.length > 0
        ? `Pass <module>/<name>. Registered: ${known.join(", ")}.`
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

/** `lstat`, or undefined when nothing is there. Never follows a symlink. */
async function lstatOrMissing(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function linkTarget(link: string): Promise<string> {
  return realpath(link).catch(() => "a missing target");
}

function symlinkRefusal(relativePath: string, resolved: string): Error {
  return new Error(
    `${LABEL}: ${relativePath} is a symlink (to ${resolved}). This command deletes only real directories under the project's own ` +
      `.metaproject/ and will not delete through, or unlink, a link. ${UNCHANGED} Remove the link by hand if that is what you want, then retry.`,
  );
}

/**
 * True when every component of `relativePath` is a real directory — so what is
 * at that path is inside the project, not somewhere a link points. False when
 * the walk runs out of disk first (nothing there to remove). A symlink or a
 * non-directory on the way is a refusal, not a "missing".
 */
async function isRealDirectoryChain(root: string, relativePath: string): Promise<boolean> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stats = await lstatOrMissing(current);
    if (stats === undefined) return false;
    const shown = toPosix(path.relative(root, current));
    if (stats.isSymbolicLink()) {
      throw symlinkRefusal(shown, await linkTarget(current));
    }
    if (!stats.isDirectory()) {
      throw new Error(`${LABEL}: ${shown} is not a directory. ${UNCHANGED}`);
    }
  }
  return true;
}

type RewritableFile = {
  /** Where the bytes are: read from here. Writes go through `writeContained`, which resolves the same way. */
  absolute: string;
  /** Project-relative posix path of `absolute`, set only when it is not the path asked for. */
  resolvedPath?: string;
};

/**
 * A file this command rewrites in place (the manifest, the catalog), or
 * undefined when there is none. Unlike a thing to delete, it may be reached
 * through a symlink — `CLAUDE.md -> AGENTS.md`-style layouts are legitimate —
 * but only to a regular file inside the project: a removal never edits a
 * manifest or a catalog that belongs to something else.
 */
async function locateRewritable(root: string, relativePath: string): Promise<RewritableFile | undefined> {
  const lexical = path.join(root, relativePath);
  if ((await lstatOrMissing(lexical)) === undefined) return undefined;
  const absolute = await realpath(lexical).catch(() => undefined);
  if (absolute === undefined) {
    throw new Error(`${LABEL}: ${relativePath} is a broken symlink. ${UNCHANGED}`);
  }
  if (absolute === root || !isPathInside(root, absolute)) {
    throw new Error(
      `${LABEL}: ${relativePath} resolves to ${absolute}, outside the project. Refusing to rewrite a file the project does not own. ${UNCHANGED}`,
    );
  }
  if (!(await lstat(absolute)).isFile()) {
    throw new Error(`${LABEL}: ${relativePath} is not a regular file. ${UNCHANGED}`);
  }
  const resolvedPath = toPosix(path.relative(root, absolute));
  return resolvedPath === relativePath ? { absolute } : { absolute, resolvedPath };
}

/**
 * `catalog` without this skill's row in the generated section — and with
 * nothing else in the file touched — or undefined when there is no such row.
 *
 * `updateSkillsCatalog` would regenerate the whole section from the registry;
 * that also CREATES the section (and the file) when absent, which is not a
 * removal's business, and it cannot say whether a row was there to remove.
 */
function withoutCatalogRow(catalog: string, target: Target): string | undefined {
  const lines = catalog.split("\n");
  const start = lines.findIndex((line) => line.trim() === PROJECT_SKILLS_CATALOG_START);
  const end = lines.findIndex((line, index) => index > start && line.trim() === PROJECT_SKILLS_CATALOG_END);
  if (start < 0 || end < 0) {
    return undefined;
  }

  const isTableLine = (line: string): boolean => line.trimStart().startsWith("|");
  const isTargetRow = (line: string): boolean => {
    if (!isTableLine(line)) return false;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return cells[0] === target.module && cells[1] === target.name;
  };

  const section = lines.slice(start + 1, end);
  const kept = section.filter((line) => !isTargetRow(line));
  if (kept.length === section.length) {
    return undefined;
  }

  // Header and separator are the first two table lines; a table left with
  // only those gets the placeholder row an empty registry renders.
  if (kept.filter(isTableLine).length <= 2) {
    const lastTableLine = kept.reduce((last, line, index) => (isTableLine(line) ? index : last), -1);
    kept.splice(lastTableLine + 1, 0, PROJECT_SKILLS_CATALOG_EMPTY_ROW);
  }
  return [...lines.slice(0, start + 1), ...kept, ...lines.slice(end)].join("\n");
}

/**
 * The regular files in the reports directory that are this skill's report.
 *
 * `keryx skills verify` names its report `<module>-<name>-verification.json`,
 * where `<module>` is the SKILL.md `Module:` header when there is one — which
 * can differ from the registry's — and records the package path in the body.
 * So a report that says which package it is about (`skillPath`) is this skill's
 * exactly when that is this package, whatever the file is called: `a/b-c` and
 * `a-b/c` share a file name, and the name alone would hand one skill's report
 * to the other. A report that does not say is matched by the conventional name,
 * or by the `module` and `name` in its body.
 */
async function findReports(root: string, target: Target): Promise<{ existing: string[]; conventional: string }> {
  const conventionalName = projectSkillReportFileName(target.module, target.name);
  const conventional = `${PROJECT_SKILL_REPORTS_DIR}/${conventionalName}`;
  const existing: string[] = [];
  // Also what makes the lock directory (a sibling of `reports/`) safe to create.
  if (!(await isRealDirectoryChain(root, PROJECT_SKILL_REPORTS_DIR))) {
    return { existing, conventional };
  }
  const reportsRoot = path.join(root, PROJECT_SKILL_REPORTS_DIR);
  for (const entry of await readdir(reportsRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith(PROJECT_SKILL_REPORT_SUFFIX)) continue;
    if (entry.isSymbolicLink() && entry.name === conventionalName) {
      throw symlinkRefusal(conventional, await linkTarget(path.join(reportsRoot, entry.name)));
    }
    if (!entry.isFile()) continue;
    const report = await readJsonFileOr<{ module?: unknown; name?: unknown; skillPath?: unknown } | null>(
      path.join(reportsRoot, entry.name),
      null,
    );
    const body = report !== null && typeof report === "object" ? report : {};
    const isThisSkills =
      typeof body.skillPath === "string"
        ? toPosix(body.skillPath).replace(/\/+$/, "") === target.packagePath
        : entry.name === conventionalName || (body.module === target.module && body.name === target.name);
    if (isThisSkills) {
      existing.push(`${PROJECT_SKILL_REPORTS_DIR}/${entry.name}`);
    }
  }
  return { existing: existing.sort(), conventional };
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
    const resolved = part.resolvedPath === undefined ? "" : ` (resolves to ${part.resolvedPath})`;
    lines.push(`- ${STATUS_LABEL[part.status]}: ${PART_LABEL[part.part]} — ${part.path}${resolved}`);
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
    (a report whose body names another package is left alone)

A part that is already gone is reported as absent, not as an error, so a skill
half-removed by hand can be finished with this command.

--dry-run:
  print what would be removed and change nothing.

--json:
  print { module, name, dryRun, parts: [{ part, path, status }] }, where status
  is removed | would-remove | absent. A part rewritten through a symlink also
  carries resolvedPath, the file the write lands in.

Refused, always before anything is changed:
  - a bundled skill. Those are managed by \`keryx skills install\` and
    \`keryx skills uninstall\`. A project skill imported over a bundled name
    (\`import --force\`) is a project skill and is removable.
  - a name that is not a project skill. Names are listed by \`keryx skills list\`.
  - a registry entry whose "path" is not its own
    .metaproject/project-skills/<module>/<name>, or whose module or name is not
    a plain path segment. Fix the entry in .metaproject/metaproject.json.
  - a symlink where something would be deleted: project-skills/, the <module>/
    directory, the package itself, or the reports directory. Nothing is deleted
    through a link, and the link is not unlinked.
  - a metaproject.json or catalog.md that resolves outside the project.

Not removed: rules an import copied into .metaproject/rules/ (other skills may
cite them), runtime exports under .metaproject/runtime/skills/, and learning
proposals under .metaproject/data/gdskills/proposals/.

Examples:
  keryx skills remove review/review-house-api --dry-run
  keryx skills remove review/review-house-api
  keryx skills remove quality/verifier --json
`);
}
