import path from "node:path";
import { pathExists } from "../lib/fs";
import type { ProjectSkillRegistryEntry } from "./project-skills";

export type ResolvedProjectSkill = {
  packageRoot: string;
  entry?: ProjectSkillRegistryEntry | undefined;
};

export async function resolveProjectSkill(
  projectRoot: string,
  input: string,
  registry: ProjectSkillRegistryEntry[],
): Promise<ResolvedProjectSkill | undefined> {
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
