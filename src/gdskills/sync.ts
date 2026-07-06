import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { SkillRuntime } from "./export";

export type SyncRuntimeSkillsOptions = {
  runtime: SkillRuntime;
  target: string;
  dryRun?: boolean;
};

export type SyncRuntimeSkillsResult = {
  runtime: SkillRuntime;
  sourceRoot: string;
  targetRoot: string;
  syncedSkills: string[];
  files: string[];
  manifestPath: string;
  dryRun: boolean;
};

export async function syncRuntimeSkills(
  projectRoot: string,
  options: SyncRuntimeSkillsOptions,
): Promise<SyncRuntimeSkillsResult> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: gd-metapro init");
  }

  const sourceRoot = path.join(metaprojectRoot, "runtime", "skills", options.runtime);
  if (!(await pathExists(sourceRoot))) {
    throw new Error(`No exported runtime skills found for ${options.runtime}. Run: gd-metapro skills export <skill> --runtime ${options.runtime}`);
  }

  const targetRoot = path.resolve(projectRoot, options.target);
  const skillDirs = await listSkillArtifactDirs(sourceRoot);
  if (skillDirs.length === 0) {
    throw new Error(`No runtime skill artifacts found in ${toPosix(path.relative(projectRoot, sourceRoot))}`);
  }

  const files = await plannedSyncFiles(projectRoot, skillDirs, sourceRoot, targetRoot);
  const manifestPath = path.join(targetRoot, "gd-metapro-sync-manifest.json");
  const syncedSkills = skillDirs.map((skillDir) => path.basename(skillDir)).sort();

  if (!options.dryRun) {
    await mkdir(targetRoot, { recursive: true });
    for (const skillDir of skillDirs) {
      const targetSkillDir = path.join(targetRoot, path.basename(skillDir));
      await copyDirectory(skillDir, targetSkillDir);
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        runtime: options.runtime,
        sourceRoot: toPosix(path.relative(projectRoot, sourceRoot)),
        targetRoot,
        syncedSkills,
        syncedAt: new Date().toISOString(),
        mode: "explicit-target",
      }, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    runtime: options.runtime,
    sourceRoot: toPosix(path.relative(projectRoot, sourceRoot)),
    targetRoot,
    syncedSkills,
    files: [
      ...files,
      toPosix(path.relative(projectRoot, manifestPath)),
    ],
    manifestPath: toPosix(path.relative(projectRoot, manifestPath)),
    dryRun: options.dryRun === true,
  };
}

async function listSkillArtifactDirs(sourceRoot: string): Promise<string[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(sourceRoot, entry.name);
    if (await pathExists(path.join(skillDir, "SKILL.md"))) {
      dirs.push(skillDir);
    }
  }

  return dirs.sort();
}

async function plannedSyncFiles(
  projectRoot: string,
  skillDirs: string[],
  sourceRoot: string,
  targetRoot: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const skillDir of skillDirs) {
    for (const filePath of await listFiles(skillDir)) {
      files.push(path.join(targetRoot, path.relative(sourceRoot, filePath)));
    }
  }

  return files.map((filePath) => toPosix(path.relative(projectRoot, filePath)));
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
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

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
