import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

export async function installGdskills(
  metaprojectRoot: string,
  profile: GdskillsProfile,
): Promise<InstallGdskillsResult> {
  const skills = getBundledSkillsForProfile(profile);
  const skillsRoot = path.join(metaprojectRoot, "skills", "gdskills");
  const dataRoot = path.join(metaprojectRoot, "data", "gdskills");
  const coreRoot = path.join(metaprojectRoot, "core", "gdskills");
  const contractsRoot = path.join(coreRoot, "contracts");
  const projectSkillsRoot = path.join(metaprojectRoot, "project-skills");

  await Promise.all([
    mkdir(skillsRoot, { recursive: true }),
    mkdir(path.join(dataRoot, "artifacts"), { recursive: true }),
    mkdir(path.join(dataRoot, "reports"), { recursive: true }),
    mkdir(path.join(dataRoot, "proposals"), { recursive: true }),
    mkdir(contractsRoot, { recursive: true }),
    mkdir(projectSkillsRoot, { recursive: true }),
    mkdir(path.join(metaprojectRoot, "modules"), { recursive: true }),
  ]);

  for (const skillEntry of skills) {
    const skillDir = path.join(skillsRoot, skillEntry.category, skillEntry.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), renderBundledSkill(skillEntry), "utf8");
  }

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
        fileURLToPath(new URL(`./contracts/${fileName}`, import.meta.url)),
        path.join(contractsRoot, fileName),
      ),
    ),
  );
}
