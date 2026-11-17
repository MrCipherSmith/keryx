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
import { planInstall } from "./plan";
import { readSkillsInstallState, writeSkillsInstallState, type InstalledModuleRecord } from "./state";
import { uninstallInstall } from "./uninstall";

// Review of #1222, F2 and F1/LS-3: `keryx init`/`update` own every file of a
// bundled rule layer; the manifest install never records one, and an
// install-state record of a module the manifest dropped does not survive.

let root: string;
const sourceRoot = defaultBundledSourceRoot();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-rule-ownership-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const plan = (target: "claude" | "keryx-shell", profileId = "minimal") =>
  planInstall({ manifest: loadBundledManifest(), profileId, target, repoRoot: sourceRoot });

const processRule = (name: string) => path.join(root, ".metaproject", "rules", "process", name);

test("F2: upgrade, keryx-shell install before keryx update, then keryx update and uninstall: the process rules stay", async () => {
  // A project installed by the previous release: the procedures sit in core/.
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

test("LS-5: a stale skill under .metaproject/skills/gdskills keeps the --force advice — keryx update may never refresh it", async () => {
  const keryxShell = await plan("keryx-shell", "core");
  const skill = keryxShell.modules.flatMap((m) => m.files).find((f) => f.destination.startsWith(".metaproject/skills/gdskills/"));
  expect(skill).toBeDefined();
  if (skill === undefined) return;
  await mkdir(path.dirname(path.join(root, skill.destination)), { recursive: true });
  await writeFile(path.join(root, skill.destination), "an older skill\n");
  const [skipped] = (await applyInstall(keryxShell, root, { sourceRoot })).skipped;
  expect(skipped?.path).toBe(skill.destination);
  expect(skipped?.keryxPublished).toBeUndefined();
});

test("LS-5: only rule-layer paths count as keryx-published", async () => {
  const { isKeryxPublishedDestination } = await import("./plan");
  expect(isKeryxPublishedDestination(".metaproject/rules/process/git-rules.mdc")).toBe(true);
  expect(isKeryxPublishedDestination(".metaproject/rules/core/error-handling.mdc")).toBe(true);
  expect(isKeryxPublishedDestination(".metaproject/rules/stacks/react/x.mdc")).toBe(false);
  expect(isKeryxPublishedDestination(".metaproject/rules/project/core/x.mdc")).toBe(false);
  expect(isKeryxPublishedDestination(".metaproject/skills/gdskills/review/review-logic/SKILL.md")).toBe(false);
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
