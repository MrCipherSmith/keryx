import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { BUNDLED_GDSKILLS } from "./catalog";
import { createProjectSkill } from "./project-skills";
import { removeProjectSkill, renderRemoveProjectSkill, runSkillsRemoveCommand } from "./remove-skill";

// Flow 360 (AC3): `keryx skills remove <module>/<name>` undoes what
// `keryx skills create` / `keryx skills import` wrote — the package directory,
// the `projectSkillRegistry` entry, the catalog row and the verification
// report. Every fixture is a temp project: this command deletes things.

const roots: string[] = [];

afterEach(async () => {
  process.exitCode = 0;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const MANIFEST = path.join(".metaproject", "metaproject.json");
const CATALOG = path.join(".metaproject", "skills", "catalog.md");

function reportPath(moduleName: string, skillName: string): string {
  return path.join(".metaproject", "data", "gdskills", "reports", `${moduleName}-${skillName}-verification.json`);
}

/** A temp project with the named project skills created the way the CLI creates them. */
async function makeProject(skills: Array<{ module: string; name: string; report?: boolean }>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-remove-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  // Unrelated manifest content the removal must leave exactly as it found it.
  await writeFile(
    path.join(root, MANIFEST),
    `${JSON.stringify({ version: 1, modules: { gdskills: { enabled: true, profile: "recommended" }, memory: { enabled: true } } }, null, 2)}\n`,
    "utf8",
  );
  for (const skill of skills) {
    await createProjectSkill(root, { target: `${skill.name} concept`, module: skill.module, name: skill.name });
    if (skill.report) {
      const file = path.join(root, reportPath(skill.module, skill.name));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `${JSON.stringify({ module: skill.module, name: skill.name, skillPath: `.metaproject/project-skills/${skill.module}/${skill.name}` })}\n`,
        "utf8",
      );
    }
  }
  return root;
}

type Manifest = {
  version?: number;
  modules?: {
    memory?: { enabled?: boolean };
    gdskills?: { enabled?: boolean; profile?: string; projectSkillRegistry?: Array<{ module: string; name: string }> };
  };
};

async function registryKeys(root: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as Manifest;
  return (manifest.modules?.gdskills?.projectSkillRegistry ?? []).map((entry) => `${entry.module}/${entry.name}`);
}

function statuses(result: { parts: Array<{ part: string; status: string }> }): Record<string, string> {
  return Object.fromEntries(result.parts.map((part) => [part.part, part.status]));
}

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("flow 360 AC3: removeProjectSkill", () => {
  test("removes the package directory, the registry entry, the catalog row and the verification report", async () => {
    const root = await makeProject([
      { module: "review", name: "house-api", report: true },
      { module: "review", name: "house-ui", report: true },
    ]);

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    expect(result.module).toBe("review");
    expect(result.name).toBe("house-api");
    expect(result.dryRun).toBe(false);
    expect(statuses(result)).toEqual({ registry: "removed", catalog: "removed", package: "removed", report: "removed" });

    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-api"))).toBe(false);
    expect(await pathExists(path.join(root, reportPath("review", "house-api")))).toBe(false);
    expect(await registryKeys(root)).toEqual(["review/house-ui"]);
    const catalog = await readFile(path.join(root, CATALOG), "utf8");
    expect(catalog).not.toContain("house-api");

    // The sibling is untouched, in all four places.
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-ui", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(root, reportPath("review", "house-ui")))).toBe(true);
    expect(catalog).toContain("| review | house-ui |");

    // …and so is everything else in the manifest.
    const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as Manifest;
    expect(manifest.version).toBe(1);
    expect(manifest.modules?.memory).toEqual({ enabled: true });
    expect(manifest.modules?.gdskills?.profile).toBe("recommended");
  });

  test("removing the last project skill leaves the catalog section with its empty row, and no empty module directory", async () => {
    const root = await makeProject([{ module: "quality", name: "verifier" }]);

    const result = await removeProjectSkill(root, { skill: "quality/verifier" });

    expect(statuses(result)).toEqual({
      registry: "removed",
      catalog: "removed",
      package: "removed",
      "module-directory": "removed",
      report: "absent",
    });
    expect(await registryKeys(root)).toEqual([]);
    const catalog = await readFile(path.join(root, CATALOG), "utf8");
    expect(catalog).toContain("<!-- gdskills:project-skills:start -->");
    expect(catalog).toContain("<!-- gdskills:project-skills:end -->");
    expect(catalog).toContain("| _none_ | _none_ | _none_ | - |");
    expect(catalog).not.toContain("verifier");
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "quality"))).toBe(false);

    // The catalog a later `create` regenerates is what it would have been anyway.
    await createProjectSkill(root, { target: "again concept", module: "quality", name: "again" });
    const regenerated = await readFile(path.join(root, CATALOG), "utf8");
    expect(regenerated).toContain("| quality | again |");
    expect(regenerated).not.toContain("_none_");
  });

  test("an absent report is reported as absent, not as an error", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    const report = result.parts.find((part) => part.part === "report");
    expect(report).toEqual({
      part: "report",
      path: ".metaproject/data/gdskills/reports/review-house-api-verification.json",
      status: "absent",
    });
  });

  test("--dry-run names what would be removed and changes nothing", async () => {
    const root = await makeProject([{ module: "review", name: "house-api", report: true }]);
    const before = {
      manifest: await readFile(path.join(root, MANIFEST), "utf8"),
      catalog: await readFile(path.join(root, CATALOG), "utf8"),
    };

    const result = await removeProjectSkill(root, { skill: "review/house-api", dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(statuses(result)).toEqual({
      registry: "would-remove",
      catalog: "would-remove",
      package: "would-remove",
      "module-directory": "would-remove",
      report: "would-remove",
    });
    expect(await readFile(path.join(root, MANIFEST), "utf8")).toBe(before.manifest);
    expect(await readFile(path.join(root, CATALOG), "utf8")).toBe(before.catalog);
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-api", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(root, reportPath("review", "house-api")))).toBe(true);
    // Not even the lock directory a real run takes.
    expect(await pathExists(path.join(root, ".metaproject", "data", "gdskills", "project-skills.lock"))).toBe(false);
  });

  test("a registry entry whose directory was already deleted by hand is still removable", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await rm(path.join(root, ".metaproject", "project-skills", "review", "house-api"), { recursive: true });

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    expect(statuses(result)).toMatchObject({ registry: "removed", catalog: "removed", package: "absent" });
    expect(await registryKeys(root)).toEqual([]);
  });

  test("a package directory whose registry entry is already gone is still removable", async () => {
    // The other half-cleaned state: the manifest was edited by hand, or a
    // removal was interrupted after it dropped the registry entry.
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const manifestPath = path.join(root, MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    if (manifest.modules?.gdskills) manifest.modules.gdskills.projectSkillRegistry = [];
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    expect(statuses(result)).toMatchObject({ registry: "absent", package: "removed" });
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-api"))).toBe(false);
  });

  test("refuses a bundled skill and says what manages it", async () => {
    const bundled = BUNDLED_GDSKILLS[0];
    if (bundled === undefined) throw new Error("the bundled catalog is empty");
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const before = await readFile(path.join(root, MANIFEST), "utf8");

    for (const spelling of [`${bundled.category}/${bundled.name}`, bundled.name]) {
      await expect(removeProjectSkill(root, { skill: spelling })).rejects.toThrow(/bundled skill/);
      await expect(removeProjectSkill(root, { skill: spelling })).rejects.toThrow(/keryx skills uninstall/);
    }
    expect(await readFile(path.join(root, MANIFEST), "utf8")).toBe(before);
  });

  test("a project skill that shadows a bundled name is removable: it is in the registry", async () => {
    const bundled = BUNDLED_GDSKILLS[0];
    if (bundled === undefined) throw new Error("the bundled catalog is empty");
    const root = await makeProject([{ module: bundled.category, name: bundled.name }]);

    const result = await removeProjectSkill(root, { skill: `${bundled.category}/${bundled.name}` });

    expect(statuses(result)).toMatchObject({ registry: "removed", package: "removed" });
  });

  test("refuses an unknown name and lists what is registered", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);

    await expect(removeProjectSkill(root, { skill: "review/no-such-skill" })).rejects.toThrow(
      /project skill not found: review\/no-such-skill/,
    );
    await expect(removeProjectSkill(root, { skill: "review/no-such-skill" })).rejects.toThrow(/review\/house-api/);
    // A bare name is not a project-skill address, even when one skill has it.
    await expect(removeProjectSkill(root, { skill: "house-api" })).rejects.toThrow(/project skill not found/);
    expect(await registryKeys(root)).toEqual(["review/house-api"]);
  });

  test("never follows a name or a registry path out of project-skills", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await expect(removeProjectSkill(root, { skill: "../../etc" })).rejects.toThrow(/project skill not found/);

    // A registry entry whose `path` points elsewhere must not get that path deleted.
    const victim = path.join(root, "src");
    await mkdir(victim, { recursive: true });
    await writeFile(path.join(victim, "keep.ts"), "export {};\n", "utf8");
    const manifestPath = path.join(root, MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      modules: { gdskills: { projectSkillRegistry: Array<{ path: string }> } };
    };
    const entry = manifest.modules.gdskills.projectSkillRegistry[0];
    if (entry === undefined) throw new Error("fixture has no registry entry");
    entry.path = "src";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow(/outside \.metaproject\/project-skills/);
    expect(await pathExists(path.join(victim, "keep.ts"))).toBe(true);
  });

  test("refuses a project with no .metaproject", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-remove-"));
    roots.push(root);
    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow(/not initialized/);
  });
});

describe("flow 360 AC3: keryx skills remove (command)", () => {
  test("prints exactly what it removed", async () => {
    const root = await makeProject([{ module: "review", name: "house-api", report: true }]);

    const { out } = await capture(() => runSkillsRemoveCommand(["remove", "review/house-api"], root));

    expect(out).toBe(
      [
        "Removed project skill: review/house-api",
        "- removed: registry entry — .metaproject/metaproject.json",
        "- removed: catalog row — .metaproject/skills/catalog.md",
        "- removed: package directory — .metaproject/project-skills/review/house-api",
        "- removed: module directory — .metaproject/project-skills/review",
        "- removed: verification report — .metaproject/data/gdskills/reports/review-house-api-verification.json",
      ].join("\n"),
    );
  });

  test("--dry-run prints what it would remove, and what is absent", async () => {
    const root = await makeProject([
      { module: "review", name: "house-api" },
      { module: "review", name: "house-ui" },
    ]);

    const { out } = await capture(() => runSkillsRemoveCommand(["remove", "review/house-api", "--dry-run"], root));

    expect(out).toBe(
      [
        "Would remove project skill: review/house-api",
        "- would remove: registry entry — .metaproject/metaproject.json",
        "- would remove: catalog row — .metaproject/skills/catalog.md",
        "- would remove: package directory — .metaproject/project-skills/review/house-api",
        "- absent: verification report — .metaproject/data/gdskills/reports/review-house-api-verification.json",
        "Dry run: nothing was changed.",
      ].join("\n"),
    );
    expect(await registryKeys(root)).toEqual(["review/house-api", "review/house-ui"]);
  });

  test("--json prints the result object and nothing else", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);

    const { out } = await capture(() => runSkillsRemoveCommand(["remove", "review/house-api", "--json", "--dry-run"], root));

    const parsed = JSON.parse(out) as { module: string; name: string; dryRun: boolean; parts: Array<{ part: string; status: string }> };
    expect(parsed.module).toBe("review");
    expect(parsed.name).toBe("house-api");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.parts.map((part) => part.part)).toEqual(["registry", "catalog", "package", "module-directory", "report"]);
    expect(renderRemoveProjectSkill(parsed as Parameters<typeof renderRemoveProjectSkill>[0])).toContain("Would remove project skill");
  });

  test("--help prints its own usage and removes nothing", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);

    const { out } = await capture(() => runSkillsRemoveCommand(["remove", "review/house-api", "--help"], root));

    expect(out).toContain("keryx skills remove <module>/<name> [--dry-run] [--json]");
    expect(out).not.toContain("keryx skills catalog");
    expect(await registryKeys(root)).toEqual(["review/house-api"]);
  });

  test("refuses a missing name, a second name and an unknown flag before touching anything", async () => {
    const root = await makeProject([
      { module: "review", name: "house-api" },
      { module: "review", name: "house-ui" },
    ]);

    await capture(async () => {
      await expect(runSkillsRemoveCommand(["remove"], root)).rejects.toThrow(/Usage: keryx skills remove/);
      await expect(runSkillsRemoveCommand(["remove", "review/house-api", "review/house-ui"], root)).rejects.toThrow(/one skill/);
      await expect(runSkillsRemoveCommand(["remove", "review/house-api", "--force"], root)).rejects.toThrow(/Unknown option: --force/);
    });
    expect(await registryKeys(root)).toEqual(["review/house-api", "review/house-ui"]);
  });
});
