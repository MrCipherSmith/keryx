// gdskills plugin / marketplace export (specification.md §10.2; A2/US-A302, AC7).
//
// Extends the runtime export with a `--runtime plugin` target that emits a
// plugin/marketplace package (Claude-Code plugin layout): a `.claude-plugin/`
// descriptor pair plus the skill payload under `skills/<name>/`. Pure text/file
// emit, zero runtime dependency (C0-10). Round-trips: `importPluginSkill` reads a
// package back into a comparable shape (AC7 export→import test).

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, toPosix } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";

export interface PluginExportInput {
  packageRoot: string;
  module: string;
  name: string;
  projectRoot: string;
  outputRoot: string;
  dryRun?: boolean;
}

export interface PluginExportResult {
  files: string[];
}

const SAFE_DIRS = ["references", "templates", "assets", "scripts"];

function skillTitle(skillMd: string, fallback: string): string {
  const heading = skillMd.split("\n").find((line) => line.startsWith("# "));
  return heading ? heading.slice(2).trim() : fallback;
}

function skillDescription(skillMd: string): string {
  // First non-heading, non-metadata paragraph line.
  for (const line of skillMd.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith("#") &&
      !/^(Version|Status|Type|Last Verified|Module):/i.test(trimmed)
    ) {
      return trimmed.slice(0, 240);
    }
  }
  return `Metaproject project skill: ${skillTitle(skillMd, "skill")}`;
}

function skillVersion(skillMd: string): string {
  return skillMd.match(/^Version:\s*(.+)$/m)?.[1]?.trim() ?? "0.1.0";
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function copyDirIfExists(from: string, to: string): Promise<void> {
  if (!(await pathExists(from))) {
    return;
  }
  for (const file of await listFiles(from)) {
    const target = path.join(to, path.relative(from, file));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
  }
}

// Emit the plugin/marketplace package. Deterministic layout; the only volatile
// field is `exportedAt` inside `export-manifest.json` (not part of the round-trip
// equivalence check).
export async function exportPluginSkill(
  input: PluginExportInput,
): Promise<PluginExportResult> {
  const skillMdPath = path.join(input.packageRoot, "SKILL.md");
  const skillMd = (await pathExists(skillMdPath)) ? await readFile(skillMdPath, "utf8") : "";
  const pluginName = `${input.module}-${input.name}`;
  const description = skillDescription(skillMd);
  const version = skillVersion(skillMd);

  const skillDir = path.join(input.outputRoot, "skills", input.name);
  const claudePluginDir = path.join(input.outputRoot, ".claude-plugin");

  const pluginJson = {
    name: pluginName,
    version,
    description,
    author: { name: "keryx" },
    skills: [`./skills/${input.name}`],
  };
  const marketplaceJson = {
    name: `${pluginName}-marketplace`,
    owner: { name: "keryx" },
    plugins: [
      {
        name: pluginName,
        source: "./",
        description,
      },
    ],
  };

  const files = [
    path.join(claudePluginDir, "plugin.json"),
    path.join(claudePluginDir, "marketplace.json"),
    path.join(skillDir, "SKILL.md"),
    path.join(input.outputRoot, "export-manifest.json"),
  ];
  for (const safeDir of SAFE_DIRS) {
    const sourceDir = path.join(input.packageRoot, safeDir);
    if (await pathExists(sourceDir)) {
      for (const file of await listFiles(sourceDir)) {
        files.push(path.join(skillDir, safeDir, path.relative(sourceDir, file)));
      }
    }
  }

  if (!input.dryRun) {
    await mkdir(claudePluginDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(claudePluginDir, "plugin.json"),
      `${JSON.stringify(pluginJson, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(claudePluginDir, "marketplace.json"),
      `${JSON.stringify(marketplaceJson, null, 2)}\n`,
      "utf8",
    );
    if (skillMd.length > 0) {
      await copyFile(skillMdPath, path.join(skillDir, "SKILL.md"));
    }
    for (const safeDir of SAFE_DIRS) {
      await copyDirIfExists(
        path.join(input.packageRoot, safeDir),
        path.join(skillDir, safeDir),
      );
    }
    await writeFile(
      path.join(input.outputRoot, "export-manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runtime: "plugin",
          module: input.module,
          name: input.name,
          pluginName,
          sourcePath: toPosix(path.relative(input.projectRoot, input.packageRoot)),
          outputPath: toPosix(path.relative(input.projectRoot, input.outputRoot)),
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return { files: files.map((file) => toPosix(path.relative(input.projectRoot, file))) };
}

export interface ImportedPluginSkill {
  pluginName: string;
  module: string;
  name: string;
  skillMd: string;
}

// Read a plugin package back into a comparable shape (round-trip import).
export async function importPluginSkill(
  packageRoot: string,
): Promise<ImportedPluginSkill | null> {
  const pluginJsonPath = path.join(packageRoot, ".claude-plugin", "plugin.json");
  const manifestPath = path.join(packageRoot, "export-manifest.json");
  if (!(await pathExists(pluginJsonPath)) || !(await pathExists(manifestPath))) {
    return null;
  }
  const plugin = await readJsonFileOr<{ name?: string }>(pluginJsonPath, {});
  const manifest = await readJsonFileOr<{ module?: string; name?: string }>(manifestPath, {});
  const name = manifest.name ?? "";
  const skillMdPath = path.join(packageRoot, "skills", name, "SKILL.md");
  const skillMd = (await pathExists(skillMdPath)) ? await readFile(skillMdPath, "utf8") : "";
  return {
    pluginName: plugin.name ?? "",
    module: manifest.module ?? "",
    name,
    skillMd,
  };
}
