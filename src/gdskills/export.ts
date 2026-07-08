import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, toPosix } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import type { ProjectSkillRegistryEntry } from "./project-skills";
import { resolveProjectSkill } from "./resolve";
import { exportPluginSkill } from "./export-plugin";

export type SkillRuntime = "codex" | "claude" | "plugin";

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
  if (value === "codex" || value === "claude" || value === "plugin") {
    return value;
  }

  return undefined;
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
      files: plugin.files,
      dryRun: options.dryRun === true,
    };
  }

  const files = await plannedExportFiles(projectRoot, resolved.packageRoot, outputRoot);

  if (!options.dryRun) {
    await mkdir(outputRoot, { recursive: true });
    await copyFile(path.join(resolved.packageRoot, "SKILL.md"), path.join(outputRoot, "SKILL.md"));
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
