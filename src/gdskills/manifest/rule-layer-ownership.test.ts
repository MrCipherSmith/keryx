import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { installGdskills } from "../install";
import { MOVED_RULES } from "../retired-rules";
import { applyInstall } from "./apply";
import { doctorInstall } from "./doctor";
import { defaultBundledSourceRoot, loadBundledManifest } from "./manifest";
import { getBundledSkillsForProfile } from "../catalog";
import { keryxPublishedIn, planInstall } from "./plan";
import { readSkillsInstallState, writeSkillsInstallState, type InstalledModuleRecord } from "./state";
import { uninstallInstall } from "./uninstall";

// Review of #1222, F2 and F1/LS-3: `keryx init`/`update` own every file of a
// bundled rule layer; the manifest install never records one, and an
// install-state record of a module the manifest dropped does not survive.

let root: string;
const sourceRoot = defaultBundledSourceRoot();

/** What `keryx init` leaves: the gdskills module on, with the profile `keryx update` reinstalls. */
async function writeProjectManifest(gdskills: { enabled: boolean; profile?: string }): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { gdskills } }));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-rule-ownership-"));
  await writeProjectManifest({ enabled: true, profile: "recommended" });
});

/** Destination prefix of each skill `keryx update` installs for the recommended profile. */
const recommendedSkillRoots = getBundledSkillsForProfile("recommended").map(
  (skill) => `.metaproject/skills/gdskills/${skill.category}/${skill.name}/`,
);
const inUpdateProfile = (destination: string): boolean => recommendedSkillRoots.some((prefix) => destination.startsWith(prefix));

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const plan = (target: "claude" | "keryx-shell", profileId = "minimal") =>
  planInstall({ manifest: loadBundledManifest(), profileId, target, repoRoot: sourceRoot });

const processRule = (name: string) => path.join(root, ".metaproject", "rules", "process", name);

test("F2: upgrade, keryx-shell install before keryx update, then keryx update and uninstall: the process rules stay", async () => {
  // A project installed by the previous release: the procedures sit in core/.
  // Its stack selects every pack a P4 move landed in, so every moved rule has a destination.
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    dependencies: { react: "^18.3.1", mobx: "^6.13.0", "@nestjs/core": "^10.4.0", "@playwright/test": "^1.48.0", storybook: "^8.4.0" },
  }));
  const core = path.join(root, ".metaproject", "rules", "core");
  await mkdir(core, { recursive: true });
  for (const entry of MOVED_RULES) {
    await writeFile(path.join(core, entry.fileName), `old ${entry.fileName}\n`);
  }

  const keryxShell = await plan("keryx-shell");
  expect(keryxShell.ok).toBe(true);
  const applied = await applyInstall(keryxShell, root, { sourceRoot });
  expect(applied.ok).toBe(true);
  expect(existsSync(processRule("git-rules.mdc"))).toBe(true);
  const recorded = ((await readSkillsInstallState(root, "keryx-shell"))?.installedModules ?? []).flatMap((m) => m.writtenPaths);
  expect(recorded.filter((p) => p.startsWith(".metaproject/rules/"))).toEqual([]);

  await installGdskills(path.join(root, ".metaproject"), "recommended");
  const uninstall = await uninstallInstall(root, "keryx-shell");
  expect(uninstall.removed.filter((p) => p.startsWith(".metaproject/rules/"))).toEqual([]);
  for (const entry of MOVED_RULES) {
    expect({ file: entry.movedTo, present: existsSync(path.join(root, ".metaproject", "rules", entry.movedTo)) })
      .toEqual({ file: entry.movedTo, present: true });
  }
  // Doctor does not call them orphans either.
  const doctor = await doctorInstall(root, "keryx-shell");
  expect(doctor.entries.filter((e) => e.path.startsWith(".metaproject/rules/process/"))).toEqual([]);
});

test("F2: a keryx-shell rule-layer file recorded by an older install is dropped from the record and kept by uninstall", async () => {
  const keryxShell = await plan("keryx-shell");
  await applyInstall(keryxShell, root, { sourceRoot });
  const conduct = ".metaproject/rules/process/agent-conduct.mdc";
  const stale: InstalledModuleRecord = {
    moduleId: "core-common-rules",
    writtenPaths: [conduct],
    sha256: { [conduct]: "0".repeat(64) },
    managedSentinel: true,
    installedAt: new Date(0).toISOString(),
  };
  await writeSkillsInstallState(root, "keryx-shell", [stale], "minimal");

  const uninstallFirst = await uninstallInstall(root, "keryx-shell", { moduleId: "core-common-rules", force: true });
  expect(uninstallFirst.removed).toEqual([]);
  expect(uninstallFirst.keptShared).toEqual([{ path: conduct, reason: "published by keryx init/update — left in place for them" }]);
  expect(existsSync(path.join(root, conduct))).toBe(true);
});

test("R2-LS-2: a stale bundled skill is keryx-published: never recorded, keryx update advice with the --force fallback", async () => {
  const keryxShell = await plan("keryx-shell", "core");
  const skill = keryxShell.modules.flatMap((m) => m.files).find((f) => inUpdateProfile(f.destination));
  expect(skill).toBeDefined();
  if (skill === undefined) return;
  await mkdir(path.dirname(path.join(root, skill.destination)), { recursive: true });
  await writeFile(path.join(root, skill.destination), "an older skill\n");
  const [skipped] = (await applyInstall(keryxShell, root, { sourceRoot })).skipped;
  expect(skipped?.path).toBe(skill.destination);
  expect(skipped?.keryxPublished).toBe(true);
  expect(skipped?.reason).toContain("re-run with --force (it stays unrecorded)");
  // --force writes it and still does not record it, so uninstall keeps it.
  await applyInstall(keryxShell, root, { sourceRoot, force: true });
  const recorded = ((await readSkillsInstallState(root, "keryx-shell"))?.installedModules ?? []).flatMap((m) => m.writtenPaths);
  expect(recorded).not.toContain(skill.destination);
  await uninstallInstall(root, "keryx-shell");
  expect(existsSync(path.join(root, skill.destination))).toBe(true);
});

test("R3-1: keryx-published follows the project: rule layers and the update profile's skills, only with gdskills on", async () => {
  const published = await keryxPublishedIn(root);
  const inProfile = recommendedSkillRoots[0]!;
  const outOfProfile = getBundledSkillsForProfile("full")
    .map((skill) => `.metaproject/skills/gdskills/${skill.category}/${skill.name}/`)
    .find((prefix) => !recommendedSkillRoots.includes(prefix))!;
  expect(published(".metaproject/rules/process/git-rules.mdc")).toBe(true);
  expect(published(".metaproject/rules/core/error-handling.mdc")).toBe(true);
  expect(published(`${inProfile}SKILL.md`)).toBe(true);
  expect(published(".metaproject/skills/gdskills/shared/git-merge-base.md")).toBe(true);
  expect(published(`${outOfProfile}SKILL.md`)).toBe(false);
  // A pack the project's stack does not select is not written by keryx update (ADR-0001 P4)...
  expect(published(".metaproject/rules/stacks/react/x.mdc")).toBe(false);
  expect(published(".metaproject/rules/project/core/x.mdc")).toBe(false);
  expect(published(".metaproject/project-skills/house/SKILL.md")).toBe(false);

  // Without the gdskills module keryx update writes only the conduct rule.
  await writeProjectManifest({ enabled: false });
  const off = await keryxPublishedIn(root);
  expect(off(".metaproject/rules/process/agent-conduct.mdc")).toBe(true);
  expect(off(".metaproject/rules/process/git-rules.mdc")).toBe(false);
  expect(off(`${inProfile}SKILL.md`)).toBe(false);
});

test("P4: keryx-published covers the stack packs the project's stack selects, and only those", async () => {
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18.3.1", typescript: "^5.6.0" } }));
  const published = await keryxPublishedIn(root);
  expect(published(".metaproject/rules/stacks/react/code-style-patterns.mdc")).toBe(true);
  expect(published(".metaproject/rules/stacks/ts-js-node/coding-style.mdc")).toBe(true);
  expect(published(".metaproject/rules/stacks/mobx/mobx-store-template.mdc")).toBe(false);
  expect(published(".metaproject/rules/stacks/python/coding-style.mdc")).toBe(false);
  // The seam decides, not the tree: the same selection installBundledRules makes.
  const none = await keryxPublishedIn(root, async () => []);
  expect(none(".metaproject/rules/stacks/react/code-style-patterns.mdc")).toBe(false);
});

test("R3-1: full manifest + recommended gdskills: out-of-profile skills are recorded and uninstalled, in-profile ones kept", async () => {
  const full = await plan("keryx-shell", "full");
  expect(full.ok).toBe(true);
  const skillFiles = full.modules.flatMap((m) => m.files).map((f) => f.destination).filter((d) => d.startsWith(".metaproject/skills/gdskills/"));
  const outside = skillFiles.filter((d) => !inUpdateProfile(d) && !d.startsWith(".metaproject/skills/gdskills/shared/"));
  const inside = skillFiles.filter((d) => inUpdateProfile(d));
  expect(outside.length).toBeGreaterThan(0);
  expect(inside.length).toBeGreaterThan(0);

  expect((await applyInstall(full, root, { sourceRoot })).ok).toBe(true);
  const recorded = new Set(((await readSkillsInstallState(root, "keryx-shell"))?.installedModules ?? []).flatMap((m) => m.writtenPaths));
  expect(outside.filter((d) => !recorded.has(d))).toEqual([]);
  expect(inside.filter((d) => recorded.has(d))).toEqual([]);

  const uninstall = await uninstallInstall(root, "keryx-shell");
  expect(outside.filter((d) => existsSync(path.join(root, d)))).toEqual([]);
  expect(inside.filter((d) => !existsSync(path.join(root, d)))).toEqual([]);
  expect(uninstall.removed.length).toBeGreaterThanOrEqual(outside.length);
});

for (const target of ["claude", "keryx-shell"] as const) {
  test(`F1/LS-3 (${target}): a re-install retires the record of the removed skill-lifecycle module`, async () => {
    const before = await plan(target);
    expect((await applyInstall(before, root, { sourceRoot })).ok).toBe(true);
    // What a pre-P3 install left: a skill-lifecycle record of the rule.
    const destination = target === "claude" ? ".claude/rules/skill-lifecycle.mdc" : ".metaproject/rules/core/skill-lifecycle.mdc";
    const state = await readSkillsInstallState(root, target);
    await writeSkillsInstallState(root, target, [
      ...(state?.installedModules ?? []),
      { moduleId: "skill-lifecycle", writtenPaths: [destination], sha256: { [destination]: "0".repeat(64) }, managedSentinel: true, installedAt: new Date(0).toISOString() },
    ], "minimal");

    expect((await applyInstall(await plan(target), root, { sourceRoot })).ok).toBe(true);

    const after = await readSkillsInstallState(root, target);
    expect((after?.installedModules ?? []).map((m) => m.moduleId)).not.toContain("skill-lifecycle");
    const uninstall = await uninstallInstall(root, target, { moduleId: "skill-lifecycle" });
    expect(uninstall.removed).toEqual([]);
    const lifecycle = target === "claude" ? path.join(root, ".claude", "rules", "skill-lifecycle.mdc") : processRule("skill-lifecycle.mdc");
    expect(await readFile(lifecycle, "utf8")).toContain("skill");
  });
}
