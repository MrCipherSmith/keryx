// Flow 461 AC7: the registry says what each entry is (`kind`) and, for a skill,
// which task types it supplements the implementer for, and a registry written
// before those fields existed keeps loading and routing as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { skillsCommand } from "../commands/skills";
import { importProjectSkills, updateProjectSkills } from "./import-skills";
import { importProjectRules } from "./import-rules";
import { createProjectSkill } from "./project-skills";

let cwd: string;
let source: string;
const realCwd = process.cwd();
const realLog = console.log;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-registry-kind-"));
  source = await mkdtemp(path.join(tmpdir(), "keryx-registry-kind-src-"));
  await mkdir(path.join(cwd, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(
    path.join(cwd, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: { gdskills: {} } }, null, 2)}\n`,
    "utf8",
  );
});

afterEach(async () => {
  process.chdir(realCwd);
  console.log = realLog;
  await rm(cwd, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
});

async function manifest(): Promise<{ modules: { gdskills: Record<string, unknown[]> } }> {
  return JSON.parse(await readFile(path.join(cwd, ".metaproject", "metaproject.json"), "utf8"));
}

async function writeSkill(name: string, metadata: string): Promise<string> {
  const dir = path.join(source, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "Use when writing house components."\nmetadata:\n  category: implementation\n${metadata}---\n\nbody\n`,
    "utf8",
  );
  return dir;
}

describe("the project skill registry names its kind and task types", () => {
  test("createProjectSkill records kind skill and the task types it was given", async () => {
    await createProjectSkill(cwd, {
      target: "src/ui/*.tsx",
      module: "implementation",
      name: "house-ui",
      taskTypes: ["ui_component", "fix"],
    });
    const [entry] = (await manifest()).modules.gdskills.projectSkillRegistry as Record<string, unknown>[];
    expect(entry).toMatchObject({ kind: "skill", name: "house-ui", taskTypes: ["ui_component", "fix"] });
  });

  test("a skill with no task types registers none, and not an empty list", async () => {
    await createProjectSkill(cwd, { target: "src/x.ts", module: "implementation", name: "plain" });
    const [entry] = (await manifest()).modules.gdskills.projectSkillRegistry as Record<string, unknown>[];
    expect(entry?.kind).toBe("skill");
    expect("taskTypes" in (entry ?? {})).toBe(false);
  });

  test("an imported skill's task types come from its metadata", async () => {
    const dir = await writeSkill("house-ui", "  task_types: ui_component, store_logic\n");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    const [entry] = (await manifest()).modules.gdskills.projectSkillRegistry as Record<string, unknown>[];
    expect(entry).toMatchObject({ kind: "skill", module: "implementation", taskTypes: ["ui_component", "store_logic"] });
  });

  test("an update keeps the task types, and picks up a changed list", async () => {
    const dir = await writeSkill("house-ui", "  task_types: ui_component\n");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    await writeSkill("house-ui", "  task_types: service_api\n");
    await updateProjectSkills({ projectRoot: cwd, skill: "implementation/house-ui" });
    const [entry] = (await manifest()).modules.gdskills.projectSkillRegistry as Record<string, unknown>[];
    expect(entry?.taskTypes).toEqual(["service_api"]);
  });

  test("a rule is registered under its own key with kind rule, description, globs and alwaysApply", async () => {
    const rules = path.join(source, "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(
      path.join(rules, "styling.mdc"),
      `---\ndescription: Styling\nglobs: src/**/*.css, src/**/*.tsx\nalwaysApply: false\n---\n\nUse tokens.\n`,
      "utf8",
    );
    await importProjectRules({ projectRoot: cwd, from: rules });
    const gdskills = (await manifest()).modules.gdskills;
    expect(gdskills.projectRuleRegistry).toHaveLength(1);
    expect(gdskills.projectRuleRegistry?.[0]).toMatchObject({
      kind: "rule",
      ref: "styling.mdc",
      description: "Styling",
      globs: ["src/**/*.css", "src/**/*.tsx"],
      alwaysApply: false,
    });
    expect(gdskills.projectSkillRegistry).toBeUndefined();
  });
});

describe("a registry written before flow 461 still works", () => {
  test("`skills route --json` ignores a registry entry with no kind or task types", async () => {
    await mkdir(path.join(cwd, ".metaproject", "project-skills", "legacy", "button-skill"), { recursive: true });
    await writeFile(
      path.join(cwd, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdskills: {
            projectSkillRegistry: [
              {
                module: "legacy",
                name: "button-skill",
                target: "src/button.tsx",
                path: ".metaproject/project-skills/legacy/button-skill",
                version: "0.1.0",
                status: "active",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        },
      }),
      "utf8",
    );
    process.chdir(cwd);
    const lines: string[] = [];
    console.log = (...parts: unknown[]) => void lines.push(parts.join(" "));
    await skillsCommand(["route", "button-skill", "--json"]);
    console.log = realLog;
    const result = JSON.parse(lines.join("\n")) as { matches: Record<string, unknown>[] };
    const match = result.matches.find((entry) => entry.name === "button-skill");
    expect(match).toMatchObject({ source: "project", module: "legacy", target: "src/button.tsx" });
    expect(Object.keys(match ?? {}).sort()).toEqual(
      ["module", "name", "next", "path", "reasons", "score", "source", "target"].sort(),
    );
  });
});
