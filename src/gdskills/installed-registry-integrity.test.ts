import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// This repository's OWN `.metaproject` — the installed copy an agent reads, as
// opposed to `src/gdskills/bundled`, which is the source that produces it.
// Nothing tested the installed side for internal consistency, and both defects
// below were sitting in it, committed, at the time this file was written.
const METAPROJECT = path.join(import.meta.dir, "..", "..", ".metaproject");

function manifest(): {
  modules?: { gdskills?: { projectSkillRegistry?: Array<{ module: string; name: string; path: string }> } };
} {
  return JSON.parse(readFileSync(path.join(METAPROJECT, "metaproject.json"), "utf8")) as ReturnType<typeof manifest>;
}

describe("the installed metaproject is internally consistent", () => {
  // Regression: `metaproject.json` registered two project-skills whose packages
  // did not exist. The registration was committed to `main` (a91b9afb) while the
  // packages were committed only on a branch that was never merged (e001d1a3),
  // so `keryx skills verify --all` exited 1 and every `git commit` printed
  // "gdskills verification failed" — for months, as an advisory nobody could act
  // on, because nothing said WHICH skill was missing until you ran it by hand.
  //
  // The registry is a promise that a package exists. This is the test that the
  // promise is kept, and it fails at build time rather than at the next commit.
  test("every registered project-skill has a package on disk", () => {
    const registry = manifest().modules?.gdskills?.projectSkillRegistry ?? [];
    const missing = registry
      .filter((entry) => !existsSync(path.join(METAPROJECT, "..", entry.path, "SKILL.md")))
      .map((entry) => `${entry.module}/${entry.name} -> ${entry.path}`);

    expect(missing).toEqual([]);
  });

  test("every project-skill package on disk is registered", () => {
    const root = path.join(METAPROJECT, "project-skills");
    if (!existsSync(root)) {
      return;
    }
    const registry = manifest().modules?.gdskills?.projectSkillRegistry ?? [];
    const registered = new Set(registry.map((entry) => `${entry.module}/${entry.name}`));

    const onDisk: string[] = [];
    for (const moduleDir of readdirSync(root, { withFileTypes: true })) {
      if (!moduleDir.isDirectory()) continue;
      for (const skillDir of readdirSync(path.join(root, moduleDir.name), { withFileTypes: true })) {
        if (!skillDir.isDirectory()) continue;
        if (!existsSync(path.join(root, moduleDir.name, skillDir.name, "SKILL.md"))) continue;
        onDisk.push(`${moduleDir.name}/${skillDir.name}`);
      }
    }

    // The other direction of the same promise. An unregistered package is not a
    // broken build, but it IS invisible: `skills route`, `verify --all` and
    // `learn` all walk the registry, so a package nothing registers is a skill
    // nothing can reach.
    expect(onDisk.filter((key) => !registered.has(key))).toEqual([]);
  });

  // Regression: `review-layout` was added to the bundled tree and to
  // `catalog.ts`, and its SKILL.md was copied into the installed mirror — but
  // not into the two generated indexes. `.metaproject/index.md` sends agents to
  // the module manifest and the catalog, so the skill existed while nothing
  // routed to it. The existing mirror test compares SKILL.md content only and
  // was green throughout.
  //
  // Both files are written by `keryx skills install`, which is not run against
  // this repository's own `.metaproject` (it regresses content), so the indexes
  // are maintained by hand — which is exactly why they need a gate.
  test("every installed gdskill appears in both generated indexes", () => {
    const skillsRoot = path.join(METAPROJECT, "skills", "gdskills");
    if (!existsSync(skillsRoot)) {
      return;
    }
    const catalog = readFileSync(path.join(METAPROJECT, "skills", "catalog.md"), "utf8");
    const moduleManifest = readFileSync(path.join(METAPROJECT, "modules", "gdskills.md"), "utf8");

    const missing: string[] = [];
    for (const category of readdirSync(skillsRoot, { withFileTypes: true })) {
      // `shared/` holds includes, not skills, and has no SKILL.md of its own.
      if (!category.isDirectory() || category.name === "shared") continue;
      for (const skill of readdirSync(path.join(skillsRoot, category.name), { withFileTypes: true })) {
        if (!skill.isDirectory()) continue;
        if (!existsSync(path.join(skillsRoot, category.name, skill.name, "SKILL.md"))) continue;
        if (!catalog.includes(`| ${skill.name} |`)) {
          missing.push(`${skill.name}: absent from skills/catalog.md`);
        }
        if (!moduleManifest.includes(`\`${skill.name}\``)) {
          missing.push(`${skill.name}: absent from modules/gdskills.md`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
