import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../lib/fs";
import {
  type GdskillsProfile,
  getBundledSkillsForProfile,
  renderBundledSkill,
  renderGdskillsCatalog,
  renderGdskillsManifest,
} from "./catalog";

export type InstallGdskillsResult = {
  profile: GdskillsProfile;
  installedSkills: number;
  skillsRoot: string;
  catalogPath: string;
  manifestPath: string;
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
  await installBundledRules(metaprojectRoot);

  const catalogPath = path.join(metaprojectRoot, "skills", "catalog.md");
  await writeFile(catalogPath, await preserveProjectSkillsSection(catalogPath, renderGdskillsCatalog(profile)), "utf8");

  const manifestPath = path.join(metaprojectRoot, "modules", "gdskills.md");
  await writeFile(manifestPath, renderGdskillsManifest(profile), "utf8");

  await installContracts(contractsRoot);

  return {
    profile,
    installedSkills: skills.length,
    skillsRoot,
    catalogPath,
    manifestPath,
  };
}

async function installBundledSharedSkills(skillsRoot: string): Promise<void> {
  const sharedSource = bundledSharedSourcePath();
  if (!existsSync(sharedSource)) {
    return;
  }
  await cp(sharedSource, path.join(skillsRoot, "shared"), { recursive: true, force: true });
}

async function installBundledRules(metaprojectRoot: string): Promise<void> {
  const rulesSource = bundledRulesSourcePath();
  if (!existsSync(rulesSource)) {
    return;
  }
  await cp(rulesSource, path.join(metaprojectRoot, "rules", "core"), { recursive: true, force: true });
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

async function installContracts(contractsRoot: string): Promise<void> {
  const contractFiles = [
    "agent-event.schema.json",
    "orchestrator-state.schema.json",
    "review-finding.schema.json",
    "subagent-dispatch.schema.json",
    "subagent-result.schema.json",
  ];

  await Promise.all(
    contractFiles.map((fileName) =>
      copyFile(
        contractSourcePath(fileName),
        path.join(contractsRoot, fileName),
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
