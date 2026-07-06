import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { ProjectSkillRegistryEntry } from "./project-skills";

export type SkillRuntime = "codex" | "claude";

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
  if (value === "codex" || value === "claude") {
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
    throw new Error("Metaproject is not initialized. Run: gd-metapro init");
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

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
  return manifest.modules?.gdskills?.projectSkillRegistry ?? [];
}

async function resolveProjectSkill(
  projectRoot: string,
  input: string,
  registry: ProjectSkillRegistryEntry[],
): Promise<{ packageRoot: string; entry?: ProjectSkillRegistryEntry | undefined } | undefined> {
  const directPath = path.resolve(projectRoot, input);
  const directPackage = await normalizePackagePath(directPath);
  if (directPackage) {
    return {
      packageRoot: directPackage,
      entry: registry.find((entry) => path.resolve(projectRoot, entry.path) === directPackage),
    };
  }

  const projectSkillPath = path.join(projectRoot, ".metaproject", "project-skills", input);
  const projectSkillPackage = await normalizePackagePath(projectSkillPath);
  if (projectSkillPackage) {
    return {
      packageRoot: projectSkillPackage,
      entry: registry.find((entry) => path.resolve(projectRoot, entry.path) === projectSkillPackage),
    };
  }

  const normalizedInput = input.replace(/\/SKILL\.md$/i, "");
  const entry = registry.find((candidate) => {
    const key = `${candidate.module}/${candidate.name}`;
    return (
      key === normalizedInput ||
      candidate.name === normalizedInput ||
      candidate.path === normalizedInput ||
      candidate.path.replace(/\/SKILL\.md$/i, "") === normalizedInput ||
      candidate.target === input
    );
  });
  if (!entry) {
    return undefined;
  }

  const packageRoot = path.resolve(projectRoot, entry.path);
  if (!(await pathExists(path.join(packageRoot, "SKILL.md")))) {
    return undefined;
  }

  return { packageRoot, entry };
}

async function normalizePackagePath(candidate: string): Promise<string | undefined> {
  if (await pathExists(path.join(candidate, "SKILL.md"))) {
    return candidate;
  }

  if (path.basename(candidate) === "SKILL.md" && await pathExists(candidate)) {
    return path.dirname(candidate);
  }

  return undefined;
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

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
