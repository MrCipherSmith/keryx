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
 *
 * Review round 2 (G-006, G-007): a skill is identified only by exact names —
 * the registry's, or those `readdir` returns — never by asking a possibly
 * case-insensitive filesystem whether a composed path exists; and the registry
 * entry is applied last, so a step that fails leaves the entry that lets the
 * same command find the skill again and finish.
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
    for (const [index, planned] of plan.parts.entries()) {
      let removed: boolean;
      try {
        removed = planned.apply !== undefined && (await planned.apply());
      } catch (error) {
        throw applyFailure(plan, parts, index, error);
      }
      parts.push({ ...planned.part, status: removed ? "removed" : "absent" });
    }
    return { module: plan.target.module, name: plan.target.name, dryRun, parts };
  });
}

/**
 * The error a failed step becomes: what failed, what is already gone, what is
 * still there, and how to finish. The registry entry is applied last, so at
 * any failure it is still in place and the same command still knows the skill.
 */
function applyFailure(plan: Plan, done: readonly RemovedPart[], failedIndex: number, error: unknown): Error {
  const failed = plan.parts[failedIndex]?.part;
  const key = `${plan.target.module}/${plan.target.name}`;
  const cause = error instanceof Error ? error.message : String(error);
  const describe = (part: RemovedPart): string => `${PART_LABEL[part.part]} ${part.path}`;
  const removed = done.filter((part) => part.status === "removed").map(describe);
  const remaining = plan.parts
    .slice(failedIndex)
    .map((planned) => planned.part)
    .filter((part) => part.status === "would-remove")
    .map(describe);
  return new Error(
    `${LABEL}: could not remove the ${failed === undefined ? "next part" : describe(failed)}: ${cause}. ` +
      `Removed so far: ${removed.length > 0 ? removed.join(", ") : "nothing"}. ` +
      `Still in place: ${remaining.join(", ")}. ` +
      `Fix the cause and run \`keryx skills remove ${key}\` again to finish — the registry entry is removed last, so it still names the skill — ` +
      `or remove what is still in place by hand.`,
    { cause: error },
  );
}

/**
 * Everything the removal will do, decided without writing anything.
 *
 * The parts are applied in the order they are listed: the verification
 * report(s), the catalog row, the package directory, its module directory,
 * and the registry entry LAST. The entry is what identifies the skill, so a
 * run that fails at any step leaves it in place and the same command, run
 * again, finds the skill and finishes. `resolveTarget` also accepts a leftover
 * catalog row or report, so a skill half-removed by hand can be finished too.
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

  const manifestFile = await locateRewritable(root, PROJECT_SKILLS_MANIFEST_PATH);
  const manifest = manifestFile === undefined ? undefined : await readManifest(manifestFile);
  const gdskills = manifest?.modules?.gdskills;
  const registry: unknown[] = Array.isArray(gdskills?.projectSkillRegistry) ? gdskills.projectSkillRegistry : [];
  const catalogFile = await locateRewritable(root, PROJECT_SKILLS_CATALOG_PATH);
  const catalogText = catalogFile === undefined ? undefined : await readFile(catalogFile.absolute, "utf8");

  const target = await resolveTarget(
    root,
    input,
    registry,
    async (candidate) =>
      (catalogText !== undefined && withoutCatalogRow(catalogText, candidate) !== undefined) ||
      (await findReports(root, candidate)).existing.length > 0,
  );
  const key = `${target.module}/${target.name}`;
  const parts: PlannedPart[] = [];

  // 1. Verification report(s).
  const reports = await findReports(root, target);
  for (const report of reports.existing) {
    parts.push({ part: present("report", report), apply: () => removeContained(root, report) });
  }
  if (reports.existing.length === 0) {
    parts.push(absent("report", reports.conventional));
  }

  // 2. Catalog row. Rewritten from the file as it is when the step runs, not
  // as it was when the plan was made.
  if (catalogFile !== undefined && catalogText !== undefined && withoutCatalogRow(catalogText, target) !== undefined) {
    parts.push({
      part: present("catalog", PROJECT_SKILLS_CATALOG_PATH, catalogFile.resolvedPath),
      apply: async () => {
        const current = await locateRewritable(root, PROJECT_SKILLS_CATALOG_PATH);
        const next = current === undefined ? undefined : withoutCatalogRow(await readFile(current.absolute, "utf8"), target);
        if (next === undefined) return false;
        await writeContained(root, PROJECT_SKILLS_CATALOG_PATH, next);
        return true;
      },
    });
  } else {
    parts.push(absent("catalog", PROJECT_SKILLS_CATALOG_PATH));
  }

  // 3. Package directory, and 4. the module directory `createProjectSkill`
  // made for it — removed only when this skill was the last thing in it, and
  // listed only when that is the case. Both are found by their exact names
  // (G-006): on a case-insensitive filesystem `Review/Alpha` would otherwise
  // reach `review/alpha`.
  const modulePath = `${PROJECT_SKILLS_DIR}/${target.module}`;
  const moduleExists = await isRealDirectoryChain(root, modulePath);
  const packageStats = moduleExists ? await exactEntry(path.join(root, modulePath), target.name) : undefined;
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

  // 5. Registry entry: the entries with this module AND this name, and no
  // other. Last, and re-read when the step runs, like the catalog.
  if (manifestFile !== undefined && manifestWithoutEntry(manifest, key) !== undefined) {
    parts.push({
      part: present("registry", PROJECT_SKILLS_MANIFEST_PATH, manifestFile.resolvedPath),
      apply: async () => {
        const current = await locateRewritable(root, PROJECT_SKILLS_MANIFEST_PATH);
        const next = current === undefined ? undefined : manifestWithoutEntry(await readManifest(current), key);
        if (next === undefined) return false;
        await writeContained(root, PROJECT_SKILLS_MANIFEST_PATH, next);
        return true;
      },
    });
  } else {
    parts.push(absent("registry", PROJECT_SKILLS_MANIFEST_PATH));
  }

  return { target, parts };
}

/** Not `readJsonFileOr`: a manifest that does not parse must stop a removal, not read as "nothing registered" and then be overwritten. */
async function readManifest(file: RewritableFile): Promise<MetaprojectManifest | null> {
  return readJsonFile<MetaprojectManifest | null>(file.absolute);
}

/** The manifest, serialised, without the registry entries for `key` — or undefined when it has none. Everything else is kept as it was. */
function manifestWithoutEntry(manifest: MetaprojectManifest | null | undefined, key: string): string | undefined {
  const modules = manifest?.modules;
  const gdskills = modules?.gdskills;
  if (manifest == null || modules === undefined || gdskills == null || !Array.isArray(gdskills.projectSkillRegistry)) {
    return undefined;
  }
  const registry: unknown[] = gdskills.projectSkillRegistry;
  const kept = registry.filter((entry) => registryKey(entry) !== key);
  if (kept.length === registry.length) {
    return undefined;
  }
  const next: MetaprojectManifest = { ...manifest, modules: { ...modules, gdskills: { ...gdskills, projectSkillRegistry: kept } } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** `<module>/<name>` of a registry entry, or undefined for anything that is not an entry. */
function registryKey(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const { module: moduleName, name } = entry as { module?: unknown; name?: unknown };
  return typeof moduleName === "string" && typeof name === "string" ? `${moduleName}/${name}` : undefined;
}

/**
 * Which skill the input names. Every test here is an exact, case-sensitive
 * match — against the registry, or against names read from a directory with
 * `readdir` — never a question to the filesystem about a composed path, which
 * on macOS and Windows answers for any spelling (G-006).
 *
 * `hasLeftovers` says whether a catalog row or a verification report of the
 * candidate is still there: enough to finish a skill whose entry and package
 * are already gone.
 */
async function resolveTarget(
  root: string,
  input: string,
  registry: readonly unknown[],
  hasLeftovers: (candidate: Target) => Promise<boolean>,
): Promise<Target> {
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

  // A package directory with no registry entry is what a hand-edited manifest
  // leaves behind; a catalog row or a report with neither is what a removal
  // finished partly by hand leaves. Everything under project-skills is a
  // project skill, so each is still this command's to remove.
  if (addressable) {
    const candidate: Target = { module: moduleName, name: skillName, packagePath };
    if ((await lstatExact(root, packagePath)) !== undefined || (await hasLeftovers(candidate))) {
      return candidate;
    }
  }

  // Registered under another spelling. On a case-insensitive filesystem the
  // two name one directory, so nothing may be removed under the one typed.
  const spelledOtherwise = registry
    .map(registryKey)
    .filter((entry): entry is string => entry !== undefined && entry !== key && entry.toLowerCase() === key.toLowerCase());
  if (spelledOtherwise.length > 0) {
    throw new Error(
      `${LABEL}: ${input} is not registered under that spelling; the registered spelling is ${spelledOtherwise.join(" or ")}. ` +
        `Skill names are case-sensitive: run \`keryx skills remove ${spelledOtherwise[0]}\`. ${UNCHANGED}`,
    );
  }

  const bundled = BUNDLED_GDSKILLS.find((skill) => skill.name === key || `${skill.category}/${skill.name}` === key);
  const installedBundled = addressable && (await lstatExact(root, `.metaproject/skills/gdskills/${moduleName}/${skillName}`)) !== undefined;
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

/**
 * `lstat` of `name` inside the directory `parent`, but only when `parent`
 * lists an entry spelled exactly `name`. Undefined when it does not, or when
 * `parent` is not there. A case-insensitive filesystem answers `lstat` for
 * any spelling of a name; `readdir` returns the one on disk.
 */
async function exactEntry(parent: string, name: string): Promise<Stats | undefined> {
  let names: string[];
  try {
    names = await readdir(parent);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  return names.includes(name) ? lstatOrMissing(path.join(parent, name)) : undefined;
}

/** `lstat` of `relativePath` when every one of its segments is on disk under exactly that spelling; undefined otherwise. Refuses nothing. */
async function lstatExact(root: string, relativePath: string): Promise<Stats | undefined> {
  let current = root;
  let stats: Stats | undefined;
  for (const segment of relativePath.split("/")) {
    stats = await exactEntry(current, segment);
    if (stats === undefined) return undefined;
    current = path.join(current, segment);
  }
  return stats;
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
 * the walk runs out of disk first (nothing there to remove), including when a
 * component is there only under another spelling. A symlink or a
 * non-directory on the way is a refusal, not a "missing".
 */
async function isRealDirectoryChain(root: string, relativePath: string): Promise<boolean> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    const stats = await exactEntry(current, segment);
    current = path.join(current, segment);
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

Removes, in this order, and lists each as removed or absent:
  - the verification report under .metaproject/data/gdskills/reports/
    (a report whose body names another package is left alone)
  - the row in the Project Skills section of .metaproject/skills/catalog.md
  - the package directory .metaproject/project-skills/<module>/<name>/
    (and the <module>/ directory when this was the last skill in it)
  - the projectSkillRegistry entry in .metaproject/metaproject.json

A part that is already gone is reported as absent, not as an error, so a skill
half-removed by hand can be finished with this command. The registry entry goes
last: if a step fails (a read-only directory, say), the error lists what is
already gone, and running the same command again once the cause is fixed
finishes the removal.

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
  - a name that is not a project skill. Names are listed by \`keryx skills list\`
    and are case-sensitive: Review/Alpha does not name review/alpha, even on a
    filesystem that does not tell the two apart.
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
