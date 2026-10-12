import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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
    const expectNoLock = await armNoLockCheck(root);

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
    // Not even the lock a real run takes.
    await expectNoLock();
  });

  test("a registry entry whose directory was already deleted by hand is still removable", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await rm(path.join(root, ".metaproject", "project-skills", "review", "house-api"), { recursive: true });

    const result = await removeProjectSkill(root, { skill: "review/house-api" });

    expect(statuses(result)).toMatchObject({ registry: "removed", catalog: "removed", package: "absent" });
    expect(await registryKeys(root)).toEqual([]);
  });

  test("a package directory whose registry entry is already gone is still removable", async () => {
    // The other half-cleaned state: the manifest was edited by hand. (A
    // removal drops the entry last, so an interrupted one never leaves this.)
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

/** The directory the lock is created in. `withFileLock` deletes the lock itself in `finally`, so only its parent can show that a lock was taken. */
const LOCK_PARENT = path.join(".metaproject", "data", "gdskills");

/** A modification time no run of the suite can produce: anything written to the directory moves it to now. */
const LONG_AGO = new Date("2001-01-01T00:00:00Z");

/**
 * Arms a check that no lock is taken from here on (review G-014, H-010).
 * Creating the lock and deleting it again both change its parent directory:
 * when the parent is there, its mtime is set far into the past and must still
 * be that; when it is not, it must still not be (a lock would have created it).
 * Whether a report lives beside the lock makes no difference to either.
 */
async function armNoLockCheck(root: string): Promise<() => Promise<void>> {
  const parent = path.join(root, LOCK_PARENT);
  if (!(await pathExists(parent))) {
    return async () => {
      expect(await pathExists(parent)).toBe(false);
    };
  }
  await utimes(parent, LONG_AGO, LONG_AGO);
  return async () => {
    expect((await stat(parent)).mtime.toISOString()).toBe(LONG_AGO.toISOString());
  };
}

/** Both modes are refused with `reason`, and neither wrote, removed or locked anything. */
async function expectRefusedUntouched(root: string, skill: string, reason: RegExp): Promise<void> {
  const before = {
    manifest: await readFile(path.join(root, MANIFEST), "utf8"),
    catalog: await readFile(path.join(root, CATALOG), "utf8"),
  };
  const expectNoLock = await armNoLockCheck(root);
  await expect(removeProjectSkill(root, { skill, dryRun: true })).rejects.toThrow(reason);
  await expect(removeProjectSkill(root, { skill })).rejects.toThrow(reason);
  expect(await readFile(path.join(root, MANIFEST), "utf8")).toBe(before.manifest);
  expect(await readFile(path.join(root, CATALOG), "utf8")).toBe(before.catalog);
  await expectNoLock();
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
    expect(preview.parts.find((part) => part.part === "registry")).toEqual({
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

  test("F-010: a registry entry whose name is `..` or `.` is refused, not acted on", async () => {
    // Identity of an unregistered skill is read from exact `readdir` names, so only a
    // registered entry can carry a dot name into the package path: `<module>/..` would
    // be the project-skills root. The name half of the segment check is what stops it.
    for (const dotName of ["..", "."]) {
      const root = await makeProject([{ module: "review", name: "house-api" }]);
      await editRegistry(root, (registry) =>
        registry.map((entry) => ({ ...entry, name: dotName, path: `.metaproject/project-skills/review/${dotName}` })),
      );

      await expectRefusedUntouched(root, `review/${dotName}`, /registry entry "review\/\.+" is not a <module>\/<name> pair of plain path segments/);

      expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "house-api", "SKILL.md"))).toBe(true);
    }
  });

  test("a registry path with a trailing slash is still the entry's own package directory", async () => {
    const root = await makeProject([
      { module: "review", name: "alpha" },
      { module: "review", name: "beta" },
    ]);
    await editRegistry(root, (registry) =>
      registry.map((entry) => (entry.name === "alpha" ? { ...entry, path: ".metaproject/project-skills/review/alpha/" } : entry)),
    );

    const result = await removeProjectSkill(root, { skill: "review/alpha" });

    expect(statuses(result)).toMatchObject({ registry: "removed", catalog: "removed", package: "removed" });
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "alpha"))).toBe(false);
    expect(await pathExists(path.join(root, ".metaproject", "project-skills", "review", "beta", "SKILL.md"))).toBe(true);
    expect(await registryKeys(root)).toEqual(["review/beta"]);
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

// Review round 2 (flow 360).

const PACKAGE = (moduleName: string, skillName: string): string => path.join(".metaproject", "project-skills", moduleName, skillName);

/** Where each of the five parts of `review/alpha` stands. */
async function alphaState(root: string): Promise<Record<string, unknown>> {
  const catalog = await readFile(path.join(root, CATALOG), "utf8");
  return {
    registry: await registryKeys(root),
    catalogRow: catalog.includes("| review | alpha |"),
    package: await pathExists(path.join(root, PACKAGE("review", "alpha"))),
    moduleDirectory: await pathExists(path.join(root, ".metaproject", "project-skills", "review")),
    report: await pathExists(path.join(root, reportPath("review", "alpha"))),
  };
}

const ALL_GONE = { registry: [], catalogRow: false, package: false, moduleDirectory: false, report: false };

describe("flow 360 review G-006: a skill is identified by its exact spelling", () => {
  test("Review/Alpha with review/alpha registered is refused, naming the registered spelling, and deletes nothing", async () => {
    // On a case-insensitive filesystem (macOS, Windows) `Review/Alpha` and
    // `review/alpha` are one directory: before the fix the package went while
    // the entry, row and report — all matched exactly — were reported absent.
    const root = await makeProject([{ module: "review", name: "alpha", report: true }]);
    const before = await alphaState(root);

    for (const dryRun of [true, false]) {
      await expect(removeProjectSkill(root, { skill: "Review/Alpha", dryRun })).rejects.toThrow(
        /Review\/Alpha is not registered under that spelling; the registered spelling is review\/alpha/,
      );
    }

    expect(await alphaState(root)).toEqual(before);
    expect(await pathExists(path.join(root, PACKAGE("review", "alpha"), "SKILL.md"))).toBe(true);
  });

  test("an unregistered package is found only under its exact on-disk spelling", async () => {
    const root = await makeProject([{ module: "review", name: "alpha" }]);
    await editRegistry(root, () => []);

    await expect(removeProjectSkill(root, { skill: "Review/Alpha" })).rejects.toThrow(/project skill not found: Review\/Alpha/);

    expect(await pathExists(path.join(root, PACKAGE("review", "alpha"), "SKILL.md"))).toBe(true);
  });

  test("an installed bundled skill is recognised only under its exact spelling", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await mkdir(path.join(root, ".metaproject", "skills", "gdskills", "custom", "not-in-this-catalog"), { recursive: true });

    await expect(removeProjectSkill(root, { skill: "Custom/Not-In-This-Catalog" })).rejects.toThrow(
      /project skill not found: Custom\/Not-In-This-Catalog/,
    );
  });

  test("entries review/alpha and Review/Alpha: removing Review/Alpha does not delete review/alpha's package", async () => {
    const root = await makeProject([{ module: "review", name: "alpha" }]);
    await editRegistry(root, (registry) => [
      ...registry,
      { module: "Review", name: "Alpha", path: ".metaproject/project-skills/Review/Alpha" },
    ]);

    const result = await removeProjectSkill(root, { skill: "Review/Alpha" });

    expect(statuses(result)).toMatchObject({ registry: "removed", package: "absent" });
    expect(result.parts.map((part) => part.part)).not.toContain("module-directory");
    expect(await registryKeys(root)).toEqual(["review/alpha"]);
    expect(await pathExists(path.join(root, PACKAGE("review", "alpha"), "SKILL.md"))).toBe(true);
  });

  test("a spelling that differs only in the module, or only in the name, does not reach review/alpha either", async () => {
    // Each segment is matched on its own: `Review/alpha` must not pass the
    // module directory by a case-insensitive lookup, nor `review/Alpha` the package.
    for (const [moduleName, skillName] of [
      ["Review", "alpha"],
      ["review", "Alpha"],
    ] as const) {
      const root = await makeProject([{ module: "review", name: "alpha" }]);
      await editRegistry(root, (registry) => [
        ...registry,
        { module: moduleName, name: skillName, path: `.metaproject/project-skills/${moduleName}/${skillName}` },
      ]);

      const result = await removeProjectSkill(root, { skill: `${moduleName}/${skillName}` });

      expect(statuses(result)).toMatchObject({ registry: "removed", package: "absent" });
      expect(result.parts.map((part) => part.part)).not.toContain("module-directory");
      expect(await registryKeys(root)).toEqual(["review/alpha"]);
      expect(await pathExists(path.join(root, PACKAGE("review", "alpha"), "SKILL.md"))).toBe(true);
    }
  });
});

/**
 * Renames the package `<fromModule>/<fromName>` to `<toModule>/<toName>`. Each
 * rename goes through a temporary name: a case-only rename in place is not
 * reliable on every case-insensitive filesystem.
 */
async function caseRename(root: string, fromModule: string, fromName: string, toModule: string, toName: string): Promise<void> {
  const skillsRoot = path.join(root, ".metaproject", "project-skills");
  await rename(path.join(skillsRoot, fromModule, fromName), path.join(skillsRoot, fromModule, "tmp-package"));
  await rename(path.join(skillsRoot, fromModule, "tmp-package"), path.join(skillsRoot, fromModule, toName));
  if (toModule !== fromModule) {
    await rename(path.join(skillsRoot, fromModule), path.join(skillsRoot, "tmp-module"));
    await rename(path.join(skillsRoot, "tmp-module"), path.join(skillsRoot, toModule));
  }
}

describe("flow 360 review H-001: a registered package on disk under another spelling is refused, not reported absent", () => {
  // The fixture renames the package (or its module) directory to a case
  // variant, so on every filesystem the exact path is gone and only the variant
  // is listed by `readdir`. On a case-insensitive one (macOS, Windows) the
  // variant IS the registered package, which `keryx review reviewers` still
  // finds; on a case-sensitive one it is a package nobody registered. Either
  // way, dropping the entry and the row while reporting the package absent is
  // wrong, so the refusal does not depend on the filesystem.
  for (const [moduleName, skillName] of [
    ["review", "Alpha"],
    ["Review", "alpha"],
    ["Review", "Alpha"],
  ] as const) {
    test(`registered review/alpha, on disk as ${moduleName}/${skillName}: refused, naming the on-disk spelling`, async () => {
      const root = await makeProject([{ module: "review", name: "alpha", report: true }]);
      const skillsRoot = path.join(root, ".metaproject", "project-skills");
      await caseRename(root, "review", "alpha", moduleName, skillName);
      const onDisk = `.metaproject/project-skills/${moduleName}/${skillName}`;
      const before = await readFile(path.join(root, CATALOG), "utf8");

      await expectRefusedUntouched(
        root,
        "review/alpha",
        new RegExp(
          `the package of review/alpha is on disk as ${onDisk.replace(/[./]/g, "\\$&")}, ` +
            "not \\.metaproject/project-skills/review/alpha\\.",
        ),
      );

      expect(await registryKeys(root)).toEqual(["review/alpha"]);
      expect(await readFile(path.join(root, CATALOG), "utf8")).toBe(before);
      expect(await pathExists(path.join(root, reportPath("review", "alpha")))).toBe(true);
      expect(await readdir(path.join(skillsRoot, moduleName))).toEqual([skillName]);
      expect(await pathExists(path.join(skillsRoot, moduleName, skillName, "SKILL.md"))).toBe(true);
    });
  }

  test("a variant spelling that another registry entry claims exactly is that skill's, and does not stop this removal", async () => {
    // review/alpha registered but its package gone; Review/Alpha registered and on disk.
    const root = await makeProject([{ module: "review", name: "alpha" }]);
    await caseRename(root, "review", "alpha", "Review", "Alpha");
    await editRegistry(root, (registry) => [
      ...registry,
      { module: "Review", name: "Alpha", path: ".metaproject/project-skills/Review/Alpha" },
    ]);

    const result = await removeProjectSkill(root, { skill: "review/alpha" });

    expect(statuses(result)).toMatchObject({ registry: "removed", package: "absent" });
    expect(await registryKeys(root)).toEqual(["Review/Alpha"]);
    expect(await pathExists(path.join(root, PACKAGE("Review", "Alpha"), "SKILL.md"))).toBe(true);
  });

  test("an unregistered skill found by a leftover catalog row is refused the same way when its package is under another spelling", async () => {
    const root = await makeProject([{ module: "review", name: "alpha" }]);
    await editRegistry(root, () => []);
    const skillsRoot = path.join(root, ".metaproject", "project-skills");
    await caseRename(root, "review", "alpha", "review", "ALPHA");

    await expectRefusedUntouched(root, "review/alpha", /the package of review\/alpha is on disk as \.metaproject\/project-skills\/review\/ALPHA/);

    expect(await pathExists(path.join(skillsRoot, "review", "ALPHA", "SKILL.md"))).toBe(true);
  });
});

// A permission change is how a step is made to fail; root ignores permissions.
const canForceFailures = process.getuid?.() !== 0;

async function withMode(dir: string, mode: number, run: () => Promise<void>): Promise<void> {
  await chmod(dir, mode);
  try {
    await run();
  } finally {
    await chmod(dir, 0o755);
  }
}

describe("flow 360 review G-007: a failure at any one step leaves a state the same command finishes", () => {
  // Each case makes exactly one of the five parts fail. What must hold: the
  // registry entry — the part that identifies the skill — is still there, the
  // error says how to finish, and once the cause is gone a re-run finishes.
  const cases: Array<{ part: string; dir: string[]; label: RegExp; left: Record<string, unknown> }> = [
    {
      part: "report",
      dir: [".metaproject", "data", "gdskills", "reports"],
      label: /could not remove the verification report/,
      left: { registry: ["review/alpha"], catalogRow: true, package: true, moduleDirectory: true, report: true },
    },
    {
      part: "catalog",
      dir: [".metaproject", "skills"],
      label: /could not remove the catalog row/,
      left: { registry: ["review/alpha"], catalogRow: true, package: true, moduleDirectory: true, report: false },
    },
    {
      part: "package",
      dir: [".metaproject", "project-skills", "review"],
      label: /could not remove the package directory/,
      // `rm -r` empties the package before it fails to unlink it from the read-only module directory.
      left: { registry: ["review/alpha"], catalogRow: false, package: true, moduleDirectory: true, report: false },
    },
    {
      part: "module-directory",
      dir: [".metaproject", "project-skills"],
      label: /could not remove the module directory/,
      left: { registry: ["review/alpha"], catalogRow: false, package: false, moduleDirectory: true, report: false },
    },
    {
      part: "registry",
      dir: [".metaproject"],
      label: /could not remove the registry entry/,
      left: { registry: ["review/alpha"], catalogRow: false, package: false, moduleDirectory: false, report: false },
    },
  ];

  for (const { part, dir, label, left } of cases) {
    test.skipIf(!canForceFailures)(`a failure removing the ${part} is finished by running the command again`, async () => {
      const root = await makeProject([{ module: "review", name: "alpha", report: true }]);

      await withMode(path.join(root, ...dir), 0o555, async () => {
        const failure = removeProjectSkill(root, { skill: "review/alpha" });
        await expect(failure).rejects.toThrow(label);
        await expect(failure).rejects.toThrow(/run `keryx skills remove review\/alpha` again/);
        expect(await alphaState(root)).toEqual(left);

        // While the cause is still there, a re-run still knows the skill and says the same.
        await expect(removeProjectSkill(root, { skill: "review/alpha" })).rejects.toThrow(label);
      });

      const result = await removeProjectSkill(root, { skill: "review/alpha" });
      expect(statuses(result).registry).toBe("removed");
      expect(await alphaState(root)).toEqual(ALL_GONE);
    });
  }

  test("the parts are applied report, catalog, package, module directory, registry — the entry that identifies the skill goes last", async () => {
    const root = await makeProject([{ module: "review", name: "alpha", report: true }]);

    const result = await removeProjectSkill(root, { skill: "review/alpha" });

    expect(result.parts.map((part) => part.part)).toEqual(["report", "catalog", "package", "module-directory", "registry"]);
  });

  test("a skill whose entry and package were deleted by hand is finished from its catalog row and report", async () => {
    const root = await makeProject([{ module: "review", name: "alpha", report: true }]);
    await editRegistry(root, () => []);
    await rm(path.join(root, ".metaproject", "project-skills", "review"), { recursive: true });

    const result = await removeProjectSkill(root, { skill: "review/alpha" });

    expect(statuses(result)).toEqual({ report: "removed", catalog: "removed", package: "absent", registry: "absent" });
    expect(await alphaState(root)).toEqual(ALL_GONE);
  });

  test("a report left alone is enough to finish, and a catalog row alone is too", async () => {
    const root = await makeProject([{ module: "review", name: "alpha", report: true }]);
    await editRegistry(root, () => []);
    await rm(path.join(root, ".metaproject", "project-skills", "review"), { recursive: true });
    const catalog = await readFile(path.join(root, CATALOG), "utf8");
    await writeFile(path.join(root, CATALOG), catalog.replace(/^\| review \| alpha \|.*\n/m, ""), "utf8");

    expect(statuses(await removeProjectSkill(root, { skill: "review/alpha" })).report).toBe("removed");
    expect(await alphaState(root)).toEqual(ALL_GONE);

    const root2 = await makeProject([{ module: "review", name: "alpha" }]);
    await editRegistry(root2, () => []);
    await rm(path.join(root2, ".metaproject", "project-skills", "review"), { recursive: true });

    expect(statuses(await removeProjectSkill(root2, { skill: "review/alpha" })).catalog).toBe("removed");
    expect(await alphaState(root2)).toEqual(ALL_GONE);
  });
});

describe("flow 360 review G-013 / G-014: refusals and clauses a test must notice losing", () => {
  test("R01: a registered module `..` is refused, and nothing above project-skills is touched", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const victim = path.join(root, ".metaproject", "victim", "keep.txt");
    await mkdir(path.dirname(victim), { recursive: true });
    await writeFile(victim, "keep", "utf8");
    await editRegistry(root, (registry) => [...registry, { module: "..", name: "victim", path: ".metaproject/project-skills/../victim" }]);

    await expectRefusedUntouched(root, "../victim", /not a <module>\/<name> pair/);

    expect(await pathExists(victim)).toBe(true);
  });

  test("R05: a registry entry with no path is refused", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await editRegistry(root, (registry) => registry.map(({ path: _path, ...rest }) => rest as RawEntry));

    await expectRefusedUntouched(root, "review/house-api", /has "path": undefined, not its own package directory/);

    expect(await pathExists(path.join(root, PACKAGE("review", "house-api"), "SKILL.md"))).toBe(true);
  });

  test("R12: a module path that is a file is refused as not a directory", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await rm(path.join(root, ".metaproject", "project-skills", "review"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "project-skills", "review"), "not a dir", "utf8");

    await expectRefusedUntouched(root, "review/house-api", /\.metaproject\/project-skills\/review is not a directory/);

    expect(await readFile(path.join(root, ".metaproject", "project-skills", "review"), "utf8")).toBe("not a dir");
  });

  test("R14: a broken manifest symlink is refused, not read as no manifest", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await rm(path.join(root, MANIFEST));
    await symlink(path.join(root, "nowhere.json"), path.join(root, MANIFEST));

    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow(/metaproject\.json is a broken symlink/);

    expect(await pathExists(path.join(root, PACKAGE("review", "house-api"), "SKILL.md"))).toBe(true);
  });

  test("R17: a manifest symlinked to a directory inside the project is refused as not a regular file", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await mkdir(path.join(root, "cfgdir"), { recursive: true });
    await rename(path.join(root, MANIFEST), path.join(root, "cfgdir", "keep.json"));
    await symlink(path.join("..", "cfgdir"), path.join(root, MANIFEST));

    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow(/metaproject\.json is not a regular file/);

    expect(await pathExists(path.join(root, PACKAGE("review", "house-api"), "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(root, "cfgdir", "keep.json"))).toBe(true);
  });

  test("R33: a manifest that does not parse stops the removal and is not rewritten", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await writeFile(path.join(root, MANIFEST), "{ not json", "utf8");

    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow();

    expect(await readFile(path.join(root, MANIFEST), "utf8")).toBe("{ not json");
    expect(await pathExists(path.join(root, PACKAGE("review", "house-api"), "SKILL.md"))).toBe(true);
  });

  const REPORTS = path.join(".metaproject", "data", "gdskills", "reports");

  test("R25: a report with no skillPath under another file name is matched by the module and name in its body", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const report = path.join(root, REPORTS, "legacy-verification.json");
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, JSON.stringify({ module: "review", name: "house-api" }), "utf8");

    await removeProjectSkill(root, { skill: "review/house-api" });

    expect(await pathExists(report)).toBe(false);
  });

  test("R26: a report with no skillPath naming the same name in another module is left alone", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const report = path.join(root, REPORTS, "legacy-verification.json");
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, JSON.stringify({ module: "quality", name: "house-api" }), "utf8");

    await removeProjectSkill(root, { skill: "review/house-api" });

    expect(await pathExists(report)).toBe(true);
  });

  test("R29: a json in the reports directory that is not a verification report is left alone, even when it names this package", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    const notes = path.join(root, REPORTS, "house-api-notes.json");
    await mkdir(path.dirname(notes), { recursive: true });
    await writeFile(notes, JSON.stringify({ skillPath: ".metaproject/project-skills/review/house-api" }), "utf8");

    await removeProjectSkill(root, { skill: "review/house-api" });

    expect(await pathExists(notes)).toBe(true);
  });

  test("R32 / G-014: a refused real run creates no lock, not even the directory the lock would go in", async () => {
    const root = await makeProject([{ module: "review", name: "house-api" }]);
    await rm(path.join(root, ".metaproject", "data"), { recursive: true, force: true });
    await editRegistry(root, (registry) => registry.map((entry) => ({ ...entry, path: "src" })));

    await expect(removeProjectSkill(root, { skill: "review/house-api" })).rejects.toThrow(/not its own package directory/);

    expect(await pathExists(path.join(root, ".metaproject", "data"))).toBe(false);
    expect(await readdir(path.join(root, ".metaproject"))).not.toContain("data");
  });
});

describe("flow 360 review H-007 / H-013: input spellings, the failure message, and the refusals no other test reached", () => {
  test("N21-N24: every spelling the help documents names the same skill", async () => {
    const root = await makeProject([{ module: "review", name: "alpha" }]);

    for (const spelling of [
      "review/alpha/", // N23: trailing slash
      "review/alpha/SKILL.md", // N22: the SKILL.md inside it
      ".metaproject/project-skills/review/alpha", // N24: the package path
      "./.metaproject/project-skills/review/alpha/", // N21: with ./ and a trailing slash
      "./.metaproject/project-skills/review/alpha/SKILL.md",
    ]) {
      const preview = await removeProjectSkill(root, { skill: spelling, dryRun: true });
      expect({ spelling, module: preview.module, name: preview.name, package: statuses(preview).package }).toEqual({
        spelling,
        module: "review",
        name: "alpha",
        package: "would-remove",
      });
    }

    const result = await removeProjectSkill(root, { skill: "./.metaproject/project-skills/review/alpha/" });
    expect(statuses(result)).toMatchObject({ registry: "removed", package: "removed" });
    expect(await alphaState(root)).toEqual(ALL_GONE);
  });

  test.skipIf(!canForceFailures)(
    "N12 / N13 / H-013: the failure message lists exactly what is still in place, the failed package as possibly partly removed",
    async () => {
      // The registry entry is already gone (edited by hand), so the one part
      // after the failure that is `absent` must not be listed as still in place.
      const root = await makeProject([{ module: "review", name: "alpha", report: true }]);
      await editRegistry(root, () => []);

      let message = "";
      await withMode(path.join(root, ".metaproject", "project-skills", "review"), 0o555, async () => {
        message = await removeProjectSkill(root, { skill: "review/alpha" }).then(
          () => "resolved",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      });

      expect(message).toStartWith(
        "keryx skills remove: could not remove the package directory .metaproject/project-skills/review/alpha: ",
      );
      expect(message.slice(message.indexOf(". Removed so far: "))).toBe(
        ". Removed so far: verification report .metaproject/data/gdskills/reports/review-alpha-verification.json, " +
          "catalog row .metaproject/skills/catalog.md. " +
          "Still in place: package directory .metaproject/project-skills/review/alpha (may be partly removed), " +
          "module directory .metaproject/project-skills/review. " +
          "Fix the cause and run `keryx skills remove review/alpha` again to finish — the registry entry is removed last, so it still names the skill — " +
          "or remove what is still in place by hand.",
      );
    },
  );

  test("N28: a catalog whose Project Skills section has no end marker is left exactly as it is", async () => {
    const root = await makeProject([{ module: "review", name: "alpha" }]);
    const catalog = (await readFile(path.join(root, CATALOG), "utf8")).replace("<!-- gdskills:project-skills:end -->", "");
    await writeFile(path.join(root, CATALOG), catalog, "utf8");

    const result = await removeProjectSkill(root, { skill: "review/alpha" });

    expect(statuses(result)).toMatchObject({ catalog: "absent", registry: "removed", package: "removed" });
    expect(await readFile(path.join(root, CATALOG), "utf8")).toBe(catalog);
  });

  test("N33: a report under the conventional name that is a symlink is refused; neither the link nor its target goes", async () => {
    const root = await makeProject([{ module: "review", name: "victim" }]);
    const outside = await outsideDir();
    const target = path.join(outside, "elsewhere.json");
    await writeFile(target, "{}\n", "utf8");
    const link = path.join(root, reportPath("review", "victim"));
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link);

    await expectRefusedUntouched(
      root,
      "review/victim",
      /\.metaproject\/data\/gdskills\/reports\/review-victim-verification\.json is a symlink/,
    );

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("{}\n");
    expect(await registryKeys(root)).toEqual(["review/victim"]);
  });

  test("N25: a registry entry whose module or name is not a string is nobody's entry, and is kept", async () => {
    const root = await makeProject([{ module: "review", name: "alpha" }]);
    // Would read as `review/alpha` if the fields were stringified, and its path would then be refused.
    const junk = { module: ["review"], name: "alpha", path: "src" };
    const manifestPath = path.join(root, MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { modules: { gdskills: { projectSkillRegistry: unknown[] } } };
    manifest.modules.gdskills.projectSkillRegistry.push(junk);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await removeProjectSkill(root, { skill: "review/alpha" });

    expect(statuses(result)).toMatchObject({ registry: "removed", package: "removed" });
    const after = JSON.parse(await readFile(manifestPath, "utf8")) as { modules: { gdskills: { projectSkillRegistry: unknown[] } } };
    expect(after.modules.gdskills.projectSkillRegistry).toEqual([junk]);
  });
});

describe("flow 360 AC3: keryx skills remove (command)", () => {
  test("prints exactly what it removed", async () => {
    const root = await makeProject([{ module: "review", name: "house-api", report: true }]);

    const { out } = await capture(() => runSkillsRemoveCommand(["remove", "review/house-api"], root));

    expect(out).toBe(
      [
        "Removed project skill: review/house-api",
        "- removed: verification report — .metaproject/data/gdskills/reports/review-house-api-verification.json",
        "- removed: catalog row — .metaproject/skills/catalog.md",
        "- removed: package directory — .metaproject/project-skills/review/house-api",
        "- removed: module directory — .metaproject/project-skills/review",
        "- removed: registry entry — .metaproject/metaproject.json",
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
        "- absent: verification report — .metaproject/data/gdskills/reports/review-house-api-verification.json",
        "- would remove: catalog row — .metaproject/skills/catalog.md",
        "- would remove: package directory — .metaproject/project-skills/review/house-api",
        "- would remove: registry entry — .metaproject/metaproject.json",
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
    expect(parsed.parts.map((part) => part.part)).toEqual(["report", "catalog", "package", "module-directory", "registry"]);
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
