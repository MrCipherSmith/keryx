import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

// Maps source files to the project-skill that owns them, using the gdskills
// project-skill registry in metaproject.json. This is what lets Code Health
// tag findings with `scope.skill` so gdskills can learn per skill.

export type SkillOwnership = {
  skills: string[]; // "<module>/<name>"
  skillForFile: (file: string) => string | null;
};

type RegistryEntry = {
  module?: string;
  name?: string;
  target?: string;
};

const EMPTY: SkillOwnership = { skills: [], skillForFile: () => null };

export async function loadSkillOwnership(cwd: string): Promise<SkillOwnership> {
  const manifestPath = path.join(cwd, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return EMPTY;
  }

  let registry: RegistryEntry[] = [];
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      modules?: { gdskills?: { projectSkillRegistry?: RegistryEntry[] } };
    };
    registry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  } catch {
    return EMPTY;
  }

  return buildOwnership(registry);
}

// Exposed for tests: build ownership from raw registry entries.
export function buildOwnership(registry: RegistryEntry[]): SkillOwnership {
  const entries = registry
    .filter(
      (entry): entry is Required<RegistryEntry> =>
        Boolean(entry?.module) &&
        Boolean(entry?.name) &&
        typeof entry?.target === "string",
    )
    .map((entry) => ({
      skill: `${entry.module}/${entry.name}`,
      target: normalize(entry.target),
    }))
    .filter((entry) => entry.target.length > 0);

  const skills = [...new Set(entries.map((entry) => entry.skill))].sort();

  const skillForFile = (file: string): string | null => {
    const normalized = normalize(file);
    let best: { skill: string; length: number } | null = null;
    for (const entry of entries) {
      const owns =
        normalized === entry.target ||
        normalized.startsWith(`${entry.target}/`);
      if (owns && (best === null || entry.target.length > best.length)) {
        best = { skill: entry.skill, length: entry.target.length };
      }
    }
    return best?.skill ?? null;
  };

  return { skills, skillForFile };
}

function normalize(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}
