// Flow 313 (W4 portability), T10 — `src/bundle/external.ts`: vetting and
// reference-only recording of an Agent-Skills-standard catalog (W4-AC9).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { loadSkillCatalog } from "../gdskills/governance/catalog-index";
import { scoutImports } from "../gdskills/governance/scout";
import { userStorePaths } from "../lib/keryx-home";
import { applyExternalImports, readExternalImports, vetExternalCatalog, verifyExternalImports } from "./external";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeSkill(dir: string, frontmatter: string, body = "Body text.\n"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

/**
 * A benign script file: the W8 audit's `imported-bundles`/skills surface
 * only scans script-extension files (`.sh`/`.py`/`.js`/`.ts`) — a
 * candidate with none is `audit-not-applicable` (nothing scanned), which
 * `vetExternalCatalog` refuses (`audit-not-applicable`) just as much as a
 * genuine failing finding does. A real "accepted" candidate needs one clean
 * script so the gate has something to actually clear.
 */
async function writeBenignScript(skillDir: string): Promise<void> {
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await writeFile(path.join(skillDir, "scripts", "run.sh"), "#!/bin/sh\necho hello from a benign script\n", "utf8");
}

describe("vetExternalCatalog / applyExternalImports", () => {
  test("a clean unique skill is accepted, recorded by reference, and no file is copied anywhere", async () => {
    const home = await makeTempDir("keryx-external-home-");
    const projectRoot = await makeTempDir("keryx-external-project-");
    const catalogRoot = await makeTempDir("keryx-external-catalog-");

    const skillDir = path.join(catalogRoot, "zzz-unique-widget");
    await writeSkill(
      skillDir,
      "name: zzz-unique-widget\ndescription: A completely fabricated placeholder skill sharing no vocabulary with any real catalog entry whatsoever",
    );
    await writeBenignScript(skillDir);

    const result = await vetExternalCatalog({ catalogPath: catalogRoot, projectRoot, env: process.env, homeDir: home });
    expect(result.candidates.length).toBe(1);
    const candidate = result.candidates[0]!;
    expect(candidate.decision).toBe("accepted");
    expect(candidate.reasons).toEqual([]);

    const applied = await applyExternalImports(result, { env: process.env, homeDir: home });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.written).toEqual(["zzz-unique-widget"]);

    // Reference-only: recorded in the registry, but no skill file copied anywhere.
    const read = await readExternalImports(process.env, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.registry.imports["zzz-unique-widget"]?.sourceRef).toBe(skillDir);
    expect(existsSync(path.join(projectRoot, ".metaproject", "skills"))).toBe(false);
    expect(existsSync(path.join(userStorePaths(process.env, home).skills, "zzz-unique-widget"))).toBe(false);
  });

  test("a skill duplicating an existing catalog entry is rejected by the scout gate, registry unchanged", async () => {
    const home = await makeTempDir("keryx-external-home-");
    const projectRoot = await makeTempDir("keryx-external-project-");
    const catalogRoot = await makeTempDir("keryx-external-catalog-");

    const bundled = loadSkillCatalog(projectRoot, { scope: "bundled" });
    const existing = bundled.find((entry) => entry.description.length > 0);
    expect(existing).toBeDefined();
    if (existing === undefined) return;

    const skillDir = path.join(catalogRoot, existing.name);
    await writeSkill(skillDir, `name: ${existing.name}\ndescription: ${existing.description.replace(/\n/g, " ")}`);

    const result = await vetExternalCatalog({ catalogPath: catalogRoot, projectRoot, env: process.env, homeDir: home });
    expect(result.candidates.length).toBe(1);
    const candidate = result.candidates[0]!;
    expect(candidate.decision).toBe("rejected");
    expect(candidate.reasons).toContain("scout-duplicate");
    expect(candidate.scout.decision).toBe("use");

    const applied = await applyExternalImports(result, { env: process.env, homeDir: home });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.written).toEqual([]);

    const read = await readExternalImports(process.env, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Object.keys(read.registry.imports)).toEqual([]);
  });

  test("a skill whose script contains a secret-shaped token is rejected by the audit gate, registry unchanged", async () => {
    const home = await makeTempDir("keryx-external-home-");
    const projectRoot = await makeTempDir("keryx-external-project-");
    const catalogRoot = await makeTempDir("keryx-external-catalog-");

    const skillDir = path.join(catalogRoot, "leaky-skill");
    await writeSkill(skillDir, "name: leaky-skill\ndescription: A skill that ships a script with a leaked credential in it");
    await mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await writeFile(path.join(skillDir, "scripts", "install.sh"), "#!/bin/sh\nexport AWS_KEY=AKIAABCDEFGHIJKLMNOP\n", "utf8");

    const result = await vetExternalCatalog({ catalogPath: catalogRoot, projectRoot, env: process.env, homeDir: home });
    expect(result.candidates.length).toBe(1);
    const candidate = result.candidates[0]!;
    expect(candidate.decision).toBe("rejected");
    expect(candidate.reasons).toContain("audit-failed");
    expect(candidate.audit.gate).toBe("fail");
    expect(candidate.audit.findings).toBeGreaterThan(0);

    const applied = await applyExternalImports(result, { env: process.env, homeDir: home });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.written).toEqual([]);

    const read = await readExternalImports(process.env, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Object.keys(read.registry.imports)).toEqual([]);
  });

  test("a symlink anywhere inside a candidate is refused", async () => {
    const home = await makeTempDir("keryx-external-home-");
    const projectRoot = await makeTempDir("keryx-external-project-");
    const catalogRoot = await makeTempDir("keryx-external-catalog-");

    const skillDir = path.join(catalogRoot, "symlinked-skill");
    await writeSkill(skillDir, "name: symlinked-skill\ndescription: A skill directory that contains a symlink somewhere inside it");
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(skillDir, "SKILL.md"), path.join(skillDir, "SKILL-link.md"));

    const result = await vetExternalCatalog({ catalogPath: catalogRoot, projectRoot, env: process.env, homeDir: home });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.decision).toBe("rejected");
    expect(result.candidates[0]?.reasons).toContain("symlink-refused");
  });
});

describe("verifyExternalImports", () => {
  test("distinguishes unresolvable from checksum-mismatch", async () => {
    const home = await makeTempDir("keryx-external-home-");
    const projectRoot = await makeTempDir("keryx-external-project-");
    const catalogRoot = await makeTempDir("keryx-external-catalog-");

    const staySkillDir = path.join(catalogRoot, "stays-put");
    await writeSkill(staySkillDir, "name: stays-put\ndescription: This skill's source directory will be mutated after import to trip a checksum mismatch");
    await writeBenignScript(staySkillDir);

    const goesAwaySkillDir = path.join(catalogRoot, "goes-away");
    await writeSkill(goesAwaySkillDir, "name: goes-away\ndescription: This skill's source directory will be deleted after import to trip an unresolvable status");
    await writeBenignScript(goesAwaySkillDir);

    const result = await vetExternalCatalog({ catalogPath: catalogRoot, projectRoot, env: process.env, homeDir: home });
    expect(result.candidates.every((c) => c.decision === "accepted")).toBe(true);
    const applied = await applyExternalImports(result, { env: process.env, homeDir: home });
    expect(applied.ok).toBe(true);

    // Mutate one source's file bytes (checksum mismatch)...
    await writeFile(path.join(staySkillDir, "SKILL.md"), "---\nname: stays-put\ndescription: mutated\n---\nmutated body\n", "utf8");
    // ...and delete the other's source directory entirely (unresolvable).
    await rm(goesAwaySkillDir, { recursive: true, force: true });

    const verify = await verifyExternalImports(process.env, home);
    expect(verify.ok).toBe(false);
    const byName = new Map(verify.entries.map((e) => [e.name, e.status]));
    expect(byName.get("stays-put")).toBe("checksum-mismatch");
    expect(byName.get("goes-away")).toBe("unresolvable");
  });
});

describe("scoutImports finds an accepted external import", () => {
  test("scores the recorded import against the query", async () => {
    const home = await makeTempDir("keryx-external-home-");
    const projectRoot = await makeTempDir("keryx-external-project-");
    const catalogRoot = await makeTempDir("keryx-external-catalog-");

    const skillDir = path.join(catalogRoot, "acme-widget-forge");
    await writeSkill(skillDir, "name: acme-widget-forge\ndescription: Forge acme widgets from raw acme materials with acme-grade tooling");
    await writeBenignScript(skillDir);

    const result = await vetExternalCatalog({ catalogPath: catalogRoot, projectRoot, env: process.env, homeDir: home });
    expect(result.candidates[0]?.decision).toBe("accepted");
    const applied = await applyExternalImports(result, { env: process.env, homeDir: home });
    expect(applied.ok).toBe(true);

    const scouted = scoutImports("forge acme widgets", { env: process.env, homeDir: home });
    expect(scouted.searched).toBe(true);
    if (!scouted.searched) return;
    expect(scouted.matches.some((m) => m.name === "acme-widget-forge")).toBe(true);
  });
});
