import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { BUNDLED_GDSKILLS } from "./catalog";
import { createProjectSkill, PROJECT_SKILL_REPORTS_DIR, projectSkillReportFileName } from "./project-skills";
import { removeProjectSkill, renderRemoveProjectSkill, runSkillsRemoveCommand } from "./remove-skill";
import { verifyProjectSkill } from "./verify";

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

    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow(
      /"path": "src", not its own package directory \.metaproject\/project-skills\/review\/house-api/,
    );
    expect(await pathExists(path.join(victim, "keep.ts"))).toBe(true);
  });

  test("refuses a project with no .metaproject", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-remove-"));
    roots.push(root);
    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow(/not initialized/);
  });
});

// Review round 1 (flow 360). The command deletes recursively and is driven by a
// hand-editable registry, so each of these fixes one way it could delete
// something that is not the named skill's — and each asserts that a refusal
// left every file exactly as it was.

type RawEntry = { module: string; name: string; path: string; target?: string };

async function editRegistry(root: string, edit: (registry: RawEntry[]) => RawEntry[]): Promise<void> {
  const manifestPath = path.join(root, MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { modules: { gdskills: { projectSkillRegistry: RawEntry[] } } };
  manifest.modules.gdskills.projectSkillRegistry = edit(manifest.modules.gdskills.projectSkillRegistry);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** A directory outside the project, for a symlink to point at. */
async function outsideDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-skills-remove-outside-"));
  roots.push(dir);
  return dir;
}

const LOCK = path.join(".metaproject", "data", "gdskills", "project-skills.lock");

/** Both modes are refused with `reason`, and neither wrote, removed or locked anything. */
async function expectRefusedUntouched(root: string, skill: string, reason: RegExp): Promise<void> {
  const before = {
    manifest: await readFile(path.join(root, MANIFEST), "utf8"),
    catalog: await readFile(path.join(root, CATALOG), "utf8"),
  };
  await expect(removeProjectSkill(root, { skill, dryRun: true })).rejects.toThrow(reason);
  await expect(removeProjectSkill(root, { skill })).rejects.toThrow(reason);
  expect(await readFile(path.join(root, MANIFEST), "utf8")).toBe(before.manifest);
  expect(await readFile(path.join(root, CATALOG), "utf8")).toBe(before.catalog);
  expect(await pathExists(path.join(root, LOCK))).toBe(false);
}

describe("flow 360 review F-001: nothing is deleted through a symlink", () => {
  test("a symlinked module directory is refused before anything is removed", async () => {
    const root = await makeProject([{ module: "review", name: "victim", report: true }]);
    const outside = await outsideDir();
    const moduleDir = path.join(root, ".metaproject", "project-skills", "review");
    await rename(moduleDir, path.join(outside, "review"));
    await symlink(path.join(outside, "review"), moduleDir);

    await expectRefusedUntouched(root, "review/victim", /\.metaproject\/project-skills\/review is a symlink/);

    expect(await pathExists(path.join(outside, "review", "victim", "SKILL.md"))).toBe(true);
    expect((await lstat(moduleDir)).isSymbolicLink()).toBe(true);
    expect(await pathExists(path.join(root, reportPath("review", "victim")))).toBe(true);
    expect(await registryKeys(root)).toEqual(["review/victim"]);
  });

  test("a symlinked project-skills root is refused, registered or not", async () => {
    const root = await makeProject([{ module: "review", name: "victim" }]);
    const outside = await outsideDir();
    const skillsRoot = path.join(root, ".metaproject", "project-skills");
    await rename(skillsRoot, path.join(outside, "project-skills"));
    await symlink(path.join(outside, "project-skills"), skillsRoot);

    await expectRefusedUntouched(root, "review/victim", /\.metaproject\/project-skills is a symlink/);

    // The unregistered branch reaches the same directory by name alone.
    await editRegistry(root, () => []);
    await expectRefusedUntouched(root, "review/victim", /\.metaproject\/project-skills is a symlink/);

    expect(await pathExists(path.join(outside, "project-skills", "review", "victim", "SKILL.md"))).toBe(true);
  });

  test("a package that is itself a symlink is refused: neither the link nor its target is removed", async () => {
    const root = await makeProject([{ module: "review", name: "victim" }, { module: "review", name: "other" }]);
    const outside = await outsideDir();
    const packageDir = path.join(root, ".metaproject", "project-skills", "review", "victim");
    await rename(packageDir, path.join(outside, "victim"));
    await symlink(path.join(outside, "victim"), packageDir);

    await expectRefusedUntouched(root, "review/victim", /project-skills\/review\/victim is a symlink/);

    expect((await lstat(packageDir)).isSymbolicLink()).toBe(true);
    expect(await pathExists(path.join(outside, "victim", "SKILL.md"))).toBe(true);
  });

  test("a symlinked reports directory is refused before the registry entry goes", async () => {
    const root = await makeProject([{ module: "review", name: "victim" }]);
    const outside = await outsideDir();
    await writeFile(path.join(outside, "review-victim-verification.json"), "{}\n", "utf8");
    await mkdir(path.join(root, ".metaproject", "data", "gdskills"), { recursive: true });
    await symlink(outside, path.join(root, ".metaproject", "data", "gdskills", "reports"));

    await expectRefusedUntouched(root, "review/victim", /data\/gdskills\/reports is a symlink/);

    expect(await pathExists(path.join(outside, "review-victim-verification.json"))).toBe(true);
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "victim", "SKILL.md"))).toBe(true);
  });

  test("a catalog that resolves outside the project is refused, not rewritten there", async () => {
    const root = await makeProject([{ module: "review", name: "victim" }]);
    const outside = await outsideDir();
    const skillsDir = path.join(root, ".metaproject", "skills");
    await rename(skillsDir, path.join(outside, "skills"));
    await symlink(path.join(outside, "skills"), skillsDir);
    const foreign = await readFile(path.join(outside, "skills", "catalog.md"), "utf8");

    await expectRefusedUntouched(root, "review/victim", /catalog\.md resolves to .* outside the project/);

    expect(await readFile(path.join(outside, "skills", "catalog.md"), "utf8")).toBe(foreign);
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "victim", "SKILL.md"))).toBe(true);
  });

  test("a manifest symlinked to a file inside the project is rewritten in place, and the dry run names where", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await mkdir(path.join(root, "config"), { recursive: true });
    await rename(path.join(root, MANIFEST), path.join(root, "config", "metaproject.json"));
    await symlink(path.join("..", "config", "metaproject.json"), path.join(root, MANIFEST));

    const preview = await removeProjectSkill(root, { skill: "review/house-api", dryRun: true });
    expect(preview.parts[0]).toEqual({
      part: "registry",
      path: ".metaproject/metaproject.json",
      resolvedPath: "config/metaproject.json",
      status: "would-remove",
    });
    expect(renderRemoveProjectSkill(preview)).toContain(
      "- would remove: registry entry — .metaproject/metaproject.json (resolves to config/metaproject.json)",
    );

    const result = await removeProjectSkill(root, { skill: "review/house-api" });
    // The real run touches exactly the rows the dry run listed.
    expect(result.parts).toEqual(
      preview.parts.map((part) => ({ ...part, status: part.status === "would-remove" ? ("removed" as const) : part.status })),
    );
    expect((await lstat(path.join(root, MANIFEST))).isSymbolicLink()).toBe(true);
    expect(await registryKeys(root)).toEqual([]);
  });
});

describe("flow 360 review F-002 / F-007: a registry entry is trusted only for its own <module>/<name>", () => {
  test("F-002 A: an entry whose path is the module directory does not get the module deleted", async () => {
    const root = await makeProject([
      { module: "review", name: "alpha" },
      { module: "review", name: "beta" },
    ]);
    await editRegistry(root, (registry) =>
      registry.map((entry) => (entry.name === "alpha" ? { ...entry, path: ".metaproject/project-skills/review" } : entry)),
    );

    await expectRefusedUntouched(root, "review/alpha", /registry entry for review\/alpha .*not its own package directory/);

    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "alpha", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "beta", "SKILL.md"))).toBe(true);
  });

  test("F-002 B: an entry whose path is another skill's package does not get that skill deleted", async () => {
    const root = await makeProject([
      { module: "review", name: "alpha" },
      { module: "quality", name: "gamma" },
    ]);
    await editRegistry(root, (registry) =>
      registry.map((entry) => (entry.name === "alpha" ? { ...entry, path: ".metaproject/project-skills/quality/gamma" } : entry)),
    );

    await expectRefusedUntouched(root, "review/alpha", /registry entry for review\/alpha .*not its own package directory/);

    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "quality", "gamma", "SKILL.md"))).toBe(true);
    expect(await registryKeys(root)).toEqual(["quality/gamma", "review/alpha"]);
  });

  test("F-010: an entry whose path is the project-skills root itself is refused", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await editRegistry(root, (registry) => registry.map((entry) => ({ ...entry, path: ".metaproject/project-skills" })));

    await expectRefusedUntouched(root, "review/house-api", /not its own package directory/);

    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-api", "SKILL.md"))).toBe(true);
  });

  test("F-007: a registered module that climbs out of the reports directory deletes no report elsewhere", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    // `<reports>/../../../../victim/a-b-verification.json` is `<root>/victim/a-b-verification.json`.
    const victim = path.join(root, "victim", "a-b-verification.json");
    await mkdir(path.dirname(victim), { recursive: true });
    await writeFile(victim, "{}\n", "utf8");
    await editRegistry(root, (registry) => registry.map((entry) => ({ ...entry, module: "../../../../victim/a", name: "b" })));

    await expectRefusedUntouched(root, "../../../../victim/a/b", /registry entry .* is not a <module>\/<name> pair/);

    expect(await pathExists(victim)).toBe(true);
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-api", "SKILL.md"))).toBe(true);
  });

  test("F-010: an unregistered name is addressable only as two plain segments", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await editRegistry(root, () => []);

    // `review/..` is the project-skills root; `review/.` is the module directory.
    for (const skill of ["review/..", "review/.", ".metaproject/project-skills/review/.."]) {
      await expectRefusedUntouched(root, skill, /project skill not found/);
    }

    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-api", "SKILL.md"))).toBe(true);
  });
});

describe("flow 360 review F-014 / F-016: what counts as this skill's entry, row and report", () => {
  test("F-016: one name in two modules — only the named module's entry, row, package and report go", async () => {
    const root = await makeProject([
      { module: "review", name: "shared", report: true },
      { module: "quality", name: "shared", report: true },
    ]);

    await removeProjectSkill(root, { skill: "review/shared" });

    expect(await registryKeys(root)).toEqual(["quality/shared"]);
    const catalog = await readFile(path.join(root, CATALOG), "utf8");
    expect(catalog).toContain("| quality | shared |");
    expect(catalog).not.toContain("| review | shared |");
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "quality", "shared", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(root, reportPath("quality", "shared")))).toBe(true);
    expect(await pathExists(path.join(root, reportPath("review", "shared")))).toBe(false);
  });

  test("F-016: another entry that merely points at this package is not this skill's entry", async () => {
    const root = await makeProject([
      { module: "review", name: "house-api" },
      { module: "review", name: "house-ui" },
    ]);
    await editRegistry(root, (registry) =>
      registry.map((entry) => (entry.name === "house-ui" ? { ...entry, path: ".metaproject/project-skills/review/house-api" } : entry)),
    );

    await removeProjectSkill(root, { skill: "review/house-api" });

    expect(await registryKeys(root)).toEqual(["review/house-ui"]);
    expect(await readFile(path.join(root, CATALOG), "utf8")).toContain("| review | house-ui |");
  });

  test("F-016: a skill present only in the installed bundled tree is refused as bundled", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    // Not in this build's catalog (an older or newer keryx installed it), but installed.
    await mkdir(path.join(root, ".metaproject", "skills", "gdskills", "custom", "not-in-this-catalog"), { recursive: true });

    await expectRefusedUntouched(root, "custom/not-in-this-catalog", /bundled skill/);
  });

  test("F-014: a report under another file name is found by the package path in its body", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    // `keryx skills verify` names the file after the SKILL.md `Module:` header, which can differ.
    const report = path.join(".metaproject", "data", "gdskills", "reports", "frontend-house-api-verification.json");
    await mkdir(path.dirname(path.join(root, report)), { recursive: true });
    await writeFile(
      path.join(root, report),
      JSON.stringify({ module: "frontend", name: "house-api", skillPath: ".metaproject/project-skills/review/house-api" }),
      "utf8",
    );

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    expect(result.parts.filter((part) => part.part === "report")).toEqual([
      { part: "report", path: ".metaproject/data/gdskills/reports/frontend-house-api-verification.json", status: "removed" },
    ]);
    expect(await pathExists(path.join(root, report))).toBe(false);
  });

  test("F-014: a report under the conventional name is found whatever its body says about itself", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const report = path.join(root, reportPath("review", "house-api"));
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, JSON.stringify({ status: "fresh", note: "no module, name or skillPath" }), "utf8");

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    expect(statuses(result).report).toBe("removed");
    expect(await pathExists(report)).toBe(false);
  });

  test("F-014: a report whose body names another package is that package's, even under this skill's conventional name", async () => {
    // `a-b/c` and `a/b-c` share the file name `a-b-c-verification.json`.
    const root = await makeProject([
      { module: "a", name: "b-c" },
      { module: "a-b", name: "c" },
    ]);
    const shared = path.join(root, reportPath("a", "b-c"));
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, JSON.stringify({ module: "a-b", name: "c", skillPath: ".metaproject/project-skills/a-b/c" }), "utf8");

    const result = await removeProjectSkill(root, { skill: "a/b-c" });

    expect(statuses(result).report).toBe("absent");
    expect(await pathExists(shared)).toBe(true);
  });

  test("F-019: the report `keryx skills verify` writes is the one remove looks for", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const report = await verifyProjectSkill(root, { input: "review/house-api" });
    expect(report.reportPath).toBe(`${PROJECT_SKILL_REPORTS_DIR}/${projectSkillReportFileName("review", "house-api")}`);

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    expect(result.parts.filter((part) => part.part === "report")).toEqual([{ part: "report", path: report.reportPath, status: "removed" }]);
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
