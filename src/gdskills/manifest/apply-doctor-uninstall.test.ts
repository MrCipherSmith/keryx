import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { validateInstallManifest, type InstallManifest } from "./manifest";
import { planInstall } from "./plan";
import { applyInstall } from "./apply";
import { doctorInstall } from "./doctor";
import { uninstallInstall } from "./uninstall";
import { readSkillsInstallState, skillsInstallStatePath } from "./state";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-install-apply-"));
  await mkdir(path.join(root, "rules"), { recursive: true });
  await writeFile(path.join(root, "rules", "a.mdc"), "rule a fixture\n", "utf8");
  await mkdir(path.join(root, "src", "gdskills", "bundled", "skills", "review", "fake-skill"), { recursive: true });
  await writeFile(
    path.join(root, "src", "gdskills", "bundled", "skills", "review", "fake-skill", "SKILL.md"),
    "---\nname: fake-skill\ndescription: fixture\n---\nbody\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const MANIFEST: InstallManifest = {
  schemaVersion: "1.0.0",
  profiles: {
    base: { description: "base", modules: ["rule-a", "skill-b"], components: [] },
  },
  modules: {
    "rule-a": {
      kind: "rule",
      description: "rule a",
      paths: ["rules/a.mdc"],
      targets: ["claude", "keryx-shell"],
      dependencies: [],
      defaultInstall: true,
      cost: "light",
      stability: "stable",
    },
    "skill-b": {
      kind: "skill",
      description: "skill b",
      paths: ["src/gdskills/bundled/skills/review/fake-skill/**"],
      targets: ["claude", "keryx-shell"],
      dependencies: [],
      defaultInstall: true,
      cost: "light",
      stability: "stable",
    },
  },
  components: {},
};

test("fixture manifest validates against the schema", () => {
  expect(validateInstallManifest(MANIFEST).valid).toBe(true);
});

test("apply writes files and records a schema-valid install-state; doctor reports ok", async () => {
  const plan = await planInstall({ manifest: MANIFEST, profileId: "base", target: "claude", repoRoot: root });
  expect(plan.ok).toBe(true);

  const result = await applyInstall(plan, root);
  expect(result.ok).toBe(true);
  expect(result.written).toContain(".claude/rules/a.mdc");
  expect(await readFile(path.join(root, ".claude", "rules", "a.mdc"), "utf8")).toBe("rule a fixture\n");
  expect(await readFile(path.join(root, ".claude", "skills", "fake-skill", "SKILL.md"), "utf8")).toContain("fixture");

  const state = await readSkillsInstallState(root, "claude");
  expect(state).toBeDefined();
  expect(state!.schemaVersion).toBe("1.0.0");
  expect(state!.installedModules.map((m) => m.moduleId).sort()).toEqual(["rule-a", "skill-b"]);
  for (const record of state!.installedModules) {
    expect(record.writtenPaths.length).toBeGreaterThan(0);
    for (const p of record.writtenPaths) {
      expect(record.sha256[p]).toMatch(/^[a-f0-9]{64}$/);
    }
  }
  // Raw JSON on disk parses and carries the schema version, matching the
  // installState $def's required fields.
  const raw = JSON.parse(await readFile(skillsInstallStatePath(root, "claude"), "utf8"));
  expect(raw.schemaVersion).toBe("1.0.0");
  expect(raw.target).toBe("claude");

  const doctor = await doctorInstall(root, "claude");
  expect(doctor.ok).toBe(true);
  expect(doctor.entries.every((e) => e.status === "ok")).toBe(true);
});

test("apply refuses to overwrite an unrecorded existing file without --force", async () => {
  await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
  await writeFile(path.join(root, ".claude", "rules", "a.mdc"), "hand-written, not keryx's\n", "utf8");

  const plan = await planInstall({ manifest: MANIFEST, profileId: "base", target: "claude", repoRoot: root });
  const result = await applyInstall(plan, root);
  expect(result.ok).toBe(false);
  expect(result.skipped.some((s) => s.path === ".claude/rules/a.mdc")).toBe(true);
  expect(await readFile(path.join(root, ".claude", "rules", "a.mdc"), "utf8")).toBe("hand-written, not keryx's\n");

  const forced = await applyInstall(plan, root, { force: true });
  expect(forced.ok).toBe(true);
  expect(await readFile(path.join(root, ".claude", "rules", "a.mdc"), "utf8")).toBe("rule a fixture\n");
});

test("doctor reports drifted after an edit, missing after a delete, and orphaned for an unrecorded file", async () => {
  const plan = await planInstall({ manifest: MANIFEST, profileId: "base", target: "claude", repoRoot: root });
  await applyInstall(plan, root);

  await writeFile(path.join(root, ".claude", "rules", "a.mdc"), "user edited this\n", "utf8");
  await rm(path.join(root, ".claude", "skills", "fake-skill", "SKILL.md"), { force: true });
  await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
  await writeFile(path.join(root, ".claude", "rules", "orphan.mdc"), "not recorded anywhere\n", "utf8");

  const doctor = await doctorInstall(root, "claude");
  expect(doctor.ok).toBe(false);
  const byPath = new Map(doctor.entries.map((e) => [e.path, e.status]));
  expect(byPath.get(".claude/rules/a.mdc")).toBe("drifted");
  expect(byPath.get(".claude/skills/fake-skill/SKILL.md")).toBe("missing");
  expect(byPath.get(".claude/rules/orphan.mdc")).toBe("orphaned");
});

test("uninstall refuses a drifted file without --force and removes only recorded, hash-matching files", async () => {
  const plan = await planInstall({ manifest: MANIFEST, profileId: "base", target: "claude", repoRoot: root });
  await applyInstall(plan, root);
  await writeFile(path.join(root, ".claude", "rules", "a.mdc"), "drifted content\n", "utf8");

  const refused = await uninstallInstall(root, "claude");
  expect(refused.ok).toBe(false);
  expect(refused.refused.some((r) => r.path === ".claude/rules/a.mdc")).toBe(true);
  // The undrifted module's file was still removed.
  expect(refused.removed).toContain(".claude/skills/fake-skill/SKILL.md");
  await expect(readFile(path.join(root, ".claude", "rules", "a.mdc"), "utf8")).resolves.toBe("drifted content\n");

  const forced = await uninstallInstall(root, "claude", { force: true });
  expect(forced.ok).toBe(true);
  expect(forced.removed).toContain(".claude/rules/a.mdc");
  expect(forced.diffs.length).toBeGreaterThan(0);

  const state = await readSkillsInstallState(root, "claude");
  expect(state === undefined || state.installedModules.length === 0).toBe(true);
});

test("uninstall --module scopes removal to one module", async () => {
  const plan = await planInstall({ manifest: MANIFEST, profileId: "base", target: "claude", repoRoot: root });
  await applyInstall(plan, root);

  const result = await uninstallInstall(root, "claude", { moduleId: "skill-b" });
  expect(result.ok).toBe(true);
  expect(result.removed).toContain(".claude/skills/fake-skill/SKILL.md");
  await expect(readFile(path.join(root, ".claude", "rules", "a.mdc"), "utf8")).resolves.toBe("rule a fixture\n");

  const state = await readSkillsInstallState(root, "claude");
  expect(state!.installedModules.map((m) => m.moduleId)).toEqual(["rule-a"]);
});
