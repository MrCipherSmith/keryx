import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, toPosix } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import type { ProjectSkillRegistryEntry } from "./project-skills";
import { resolveProjectSkill } from "./resolve";
import { exportPluginSkill } from "./export-plugin";

/**
 * Every runtime a skill can be exported for.
 *
 * `SKILL.md` is the one build every harness reads by default. A skill whose
 * content genuinely differs for a harness may also ship that harness's own
 * build next to it (`SKILL.codex.md`, `SKILL.cursor.md`, `SKILL.zed.md`,
 * `SKILL.opencode.md`), and when it does, that runtime's export uses it —
 * before flow 205 nothing read them and a `--runtime codex` export silently
 * shipped `SKILL.md` with the Codex build sitting unread beside it. Most skills
 * ship no per-runtime build at all (flow 257 removed the ones that were
 * byte-identical copies of `SKILL.md`); for them `SKILL.md` is simply the build.
 * `plugin` is not a harness: it is the marketplace package layout handled by
 * `exportPluginSkill`, and it has no build of its own.
 */
export const HARNESS_SKILL_RUNTIMES = ["claude", "codex", "cursor", "zed", "opencode"] as const;

export type HarnessSkillRuntime = (typeof HARNESS_SKILL_RUNTIMES)[number];

export const SKILL_RUNTIMES = [...HARNESS_SKILL_RUNTIMES, "plugin"] as const;

export type SkillRuntime = (typeof SKILL_RUNTIMES)[number];

export function isHarnessSkillRuntime(value: SkillRuntime): value is HarnessSkillRuntime {
  return (HARNESS_SKILL_RUNTIMES as readonly string[]).includes(value);
}

/**
 * The file name of a runtime's own build. `claude`'s is the canonical
 * `SKILL.md`; every other harness's is `SKILL.<runtime>.md`, which a skill
 * ships only when that harness needs different content.
 */
export function skillBuildFileName(runtime: HarnessSkillRuntime): string {
  return runtime === "claude" ? "SKILL.md" : `SKILL.${runtime}.md`;
}

export type ResolvedSkillBuild = {
  /** Basename of the build actually chosen: `SKILL.md` or e.g. `SKILL.codex.md`. */
  build: string;
  /** Absolute path of the chosen build. */
  path: string;
};

/**
 * Pick the build a runtime should receive: its own `SKILL.<runtime>.md` when
 * the skill ships one, `SKILL.md` otherwise. `SKILL.md` is the normal case,
 * not a degraded one — a skill ships a per-runtime build only when that
 * harness needs different content. Which file was chosen is always returned
 * (`build`), so an export records it instead of leaving it to guesswork.
 */
export async function resolveSkillBuild(
  packageRoot: string,
  runtime: HarnessSkillRuntime,
): Promise<ResolvedSkillBuild> {
  const own = skillBuildFileName(runtime);
  const ownPath = path.join(packageRoot, own);
  if (await pathExists(ownPath)) {
    return { build: own, path: ownPath };
  }

  const canonicalPath = path.join(packageRoot, "SKILL.md");
  if (!(await pathExists(canonicalPath))) {
    throw new Error(`Skill package has no SKILL.md: ${packageRoot}`);
  }

  return { build: "SKILL.md", path: canonicalPath };
}

export type ExportProjectSkillOptions = {
  input: string;
  runtime: SkillRuntime;
  dryRun?: boolean;
};

export type ExportProjectSkillResult = {
  runtime: SkillRuntime;
  module: string;
  name: string;
  sourcePath: string;
  outputPath: string;
  /**
   * Basename of the build copied: `SKILL.md` unless the skill ships the
   * runtime's own build (e.g. `SKILL.codex.md`). `null` for `plugin`.
   */
  sourceBuild: string | null;
  files: string[];
  dryRun: boolean;
};

type MetaprojectManifest = {
  modules?: {
    gdskills?: {
      projectSkillRegistry?: ProjectSkillRegistryEntry[];
    };
  };
};

export function normalizeSkillRuntime(value: string | undefined): SkillRuntime | undefined {
  return (SKILL_RUNTIMES as readonly string[]).includes(value ?? "")
    ? (value as SkillRuntime)
    : undefined;
}

export async function exportProjectSkill(
  projectRoot: string,
  options: ExportProjectSkillOptions,
): Promise<ExportProjectSkillResult> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: keryx init");
  }

  const registry = await readProjectSkillRegistry(projectRoot);
  const resolved = await resolveProjectSkill(projectRoot, options.input, registry);
  if (!resolved) {
    throw new Error(`Project skill not found for: ${options.input}`);
  }

  const moduleName = resolved.entry?.module ?? inferModuleFromPackageRoot(resolved.packageRoot);
  const skillName = resolved.entry?.name ?? path.basename(resolved.packageRoot);
  const runtimeName = `${moduleName}-${skillName}`;
  const outputRoot = path.join(metaprojectRoot, "runtime", "skills", options.runtime, runtimeName);

  // Plugin/marketplace export uses a distinct package layout (spec §10.2).
  if (options.runtime === "plugin") {
    const plugin = await exportPluginSkill({
      packageRoot: resolved.packageRoot,
      module: moduleName,
      name: skillName,
      projectRoot,
      outputRoot,
      dryRun: options.dryRun === true,
    });
    return {
      runtime: options.runtime,
      module: moduleName,
      name: skillName,
      sourcePath: toPosix(path.relative(projectRoot, resolved.packageRoot)),
      outputPath: toPosix(path.relative(projectRoot, outputRoot)),
      sourceBuild: null,
      files: plugin.files,
      dryRun: options.dryRun === true,
    };
  }

  // Every non-plugin runtime is a harness: it gets its own build when the
  // skill ships one, SKILL.md otherwise.
  const build = await resolveSkillBuild(resolved.packageRoot, options.runtime);
  const files = await plannedExportFiles(projectRoot, resolved.packageRoot, outputRoot);

  if (!options.dryRun) {
    await mkdir(outputRoot, { recursive: true });
    // The export target is always named SKILL.md: harnesses read a single
    // SKILL.md per installed skill directory. Which build filled it is
    // recorded in the manifest and the result, never left to guesswork.
    await copyFile(build.path, path.join(outputRoot, "SKILL.md"));
    for (const safeDir of ["references", "templates", "assets", "scripts"]) {
      await copyDirectoryIfExists(path.join(resolved.packageRoot, safeDir), path.join(outputRoot, safeDir));
    }
    await writeFile(
      path.join(outputRoot, "export-manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        runtime: options.runtime,
        module: moduleName,
        name: skillName,
        sourcePath: toPosix(path.relative(projectRoot, resolved.packageRoot)),
        outputPath: toPosix(path.relative(projectRoot, outputRoot)),
        sourceBuild: build.build,
        exportedAt: new Date().toISOString(),
        excluded: ["skill-changelog.md", "verification.md", "reports", "proposals", "audit"],
      }, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    runtime: options.runtime,
    module: moduleName,
    name: skillName,
    sourcePath: toPosix(path.relative(projectRoot, resolved.packageRoot)),
    outputPath: toPosix(path.relative(projectRoot, outputRoot)),
    sourceBuild: build.build,
    files,
    dryRun: options.dryRun === true,
  };
}

async function readProjectSkillRegistry(projectRoot: string): Promise<ProjectSkillRegistryEntry[]> {
  const manifestPath = path.join(projectRoot, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return [];
  }

  const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
  return manifest.modules?.gdskills?.projectSkillRegistry ?? [];
}

async function plannedExportFiles(
  projectRoot: string,
  sourceRoot: string,
  outputRoot: string,
): Promise<string[]> {
  const files = [path.join(outputRoot, "SKILL.md"), path.join(outputRoot, "export-manifest.json")];
  for (const safeDir of ["references", "templates", "assets", "scripts"]) {
    const sourceDir = path.join(sourceRoot, safeDir);
    if (await pathExists(sourceDir)) {
      for (const filePath of await listFiles(sourceDir)) {
        files.push(path.join(outputRoot, safeDir, path.relative(sourceDir, filePath)));
      }
    }
  }

  return files.map((filePath) => toPosix(path.relative(projectRoot, filePath)));
}

async function copyDirectoryIfExists(sourceDir: string, targetDir: string): Promise<void> {
  if (!(await pathExists(sourceDir))) {
    return;
  }

  for (const filePath of await listFiles(sourceDir)) {
    const targetPath = path.join(targetDir, path.relative(sourceDir, filePath));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(filePath, targetPath);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function inferModuleFromPackageRoot(packageRoot: string): string {
  const parts = toPosix(packageRoot).split("/");
  const index = parts.indexOf("project-skills");
  const next = parts[index + 1];
  return index >= 0 && next ? next : "general";
}
