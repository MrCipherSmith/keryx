import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import installManifestSchemaJson from "../../../docs/requirements/keryx-agent-platform-expansion/schemas/install-manifest.schema.json" with {
  type: "json",
};
import { validateAgainstSchemaObject } from "../../contracts/validator";
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
  // F19: the on-disk document is validated against install-manifest.schema.json's
  // own `$defs/installState` with the repo's real schema validator — not a
  // hand-picked field check, which would pass plenty of shapes the schema
  // itself rejects (see state.test.ts for cases where the two diverge).
  const raw = JSON.parse(await readFile(skillsInstallStatePath(root, "claude"), "utf8"));
  const installStateValidation = validateAgainstSchemaObject(
    {
      $ref: "#/$defs/installState",
      $defs: (installManifestSchemaJson as unknown as { $defs: Record<string, unknown> }).$defs,
    },
    raw,
  );
  expect(installStateValidation.errors).toEqual([]);
  expect(installStateValidation.valid).toBe(true);
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

test("F16: re-apply preserves a drifted file's record instead of demoting it to orphaned", async () => {
  // A two-file module so a re-apply that successfully rewrites one file
  // while the OTHER is drifted exercises the per-module record merge (a
  // single-file module never hit this defect, since an all-skipped module
  // was simply never touched in the batch at all).
  await writeFile(path.join(root, "rules", "b.mdc"), "rule b fixture\n", "utf8");
  const manifest: InstallManifest = {
    ...MANIFEST,
    profiles: { multi: { description: "multi", modules: ["rule-multi"], components: [] } },
    modules: {
      "rule-multi": {
        kind: "rule",
        description: "two rule files",
        paths: ["rules/a.mdc", "rules/b.mdc"],
        targets: ["claude", "keryx-shell"],
        dependencies: [],
        defaultInstall: true,
        cost: "light",
        stability: "stable",
      },
    },
    components: {},
  };

  const plan1 = await planInstall({ manifest, profileId: "multi", target: "claude", repoRoot: root });
  expect(plan1.ok).toBe(true);
  const applied1 = await applyInstall(plan1, root);
  expect(applied1.ok).toBe(true);

  // Drift a.mdc by hand, and delete b.mdc so the re-apply writes it fresh —
  // one file in the module succeeds, the other is refused as drifted.
  await writeFile(path.join(root, ".claude", "rules", "a.mdc"), "user edited this\n", "utf8");
  await rm(path.join(root, ".claude", "rules", "b.mdc"), { force: true });

  const plan2 = await planInstall({ manifest, profileId: "multi", target: "claude", repoRoot: root });
  const applied2 = await applyInstall(plan2, root);
  expect(applied2.ok).toBe(false); // a.mdc was skipped (drifted)
  expect(applied2.skipped.some((s) => s.path === ".claude/rules/a.mdc")).toBe(true);
  expect(applied2.written).toContain(".claude/rules/b.mdc");

  const state = await readSkillsInstallState(root, "claude");
  const record = state!.installedModules.find((m) => m.moduleId === "rule-multi");
  expect(record).toBeDefined();
  // Both paths are still recorded — a.mdc did not silently fall out of state.
  expect([...record!.writtenPaths].sort()).toEqual([".claude/rules/a.mdc", ".claude/rules/b.mdc"]);

  const doctor = await doctorInstall(root, "claude");
  const byPath = new Map(doctor.entries.map((e) => [e.path, e.status]));
  expect(byPath.get(".claude/rules/a.mdc")).toBe("drifted");
  expect(byPath.get(".claude/rules/a.mdc")).not.toBe("orphaned");
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

/**
 * F2 regression: review round 1's `uninstall-traversal.ts` repro planted a
 * hand-crafted install-state record naming `../victim.txt` (outside the
 * project root, alongside `repoRoot`) and showed `uninstall`/`doctor`
 * trusted it — `doctor` hashed/reported it, and `uninstall` deleted it.
 */
async function writeUnsafeState(target: string, writtenPaths: string[]): Promise<void> {
  const file = skillsInstallStatePath(root, target);
  await mkdir(path.dirname(file), { recursive: true });
  const sha = "a".repeat(64);
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: "1.0.0",
      target,
      installedModules: [
        {
          moduleId: "evil",
          writtenPaths,
          sha256: Object.fromEntries(writtenPaths.map((p) => [p, sha])),
          managedSentinel: true,
        },
      ],
      recordedAt: "2026-01-01T00:00:00.000Z",
    }),
    "utf8",
  );
}

test("F2: doctor refuses to trust an install-state record whose path escapes the project root", async () => {
  const victim = path.join(path.dirname(root), `victim-${path.basename(root)}.txt`);
  await writeFile(victim, "public content\n", "utf8");
  try {
    await writeUnsafeState("claude", ["../" + path.basename(victim)]);
    const doctor = await doctorInstall(root, "claude");
    expect(doctor.ok).toBe(false);
    expect(doctor.entries).toEqual([]);
    expect(doctor.invalidState.length).toBeGreaterThan(0);
  } finally {
    await rm(victim, { force: true });
  }
});

test("F2: uninstall refuses the whole operation and deletes nothing when a record's path escapes the project root", async () => {
  const victim = path.join(path.dirname(root), `victim-${path.basename(root)}.txt`);
  await writeFile(victim, "public content\n", "utf8");
  try {
    await writeUnsafeState("claude", ["../" + path.basename(victim)]);
    const result = await uninstallInstall(root, "claude");
    expect(result.ok).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.error).toBeDefined();
    await expect(readFile(victim, "utf8")).resolves.toBe("public content\n");

    const forced = await uninstallInstall(root, "claude", { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.removed).toEqual([]);
    await expect(readFile(victim, "utf8")).resolves.toBe("public content\n");
  } finally {
    await rm(victim, { force: true });
  }
});

test("F2: doctor refuses a record whose path is contained but outside this target's own destination roots", async () => {
  await mkdir(path.join(root, "somewhere-else"), { recursive: true });
  await writeFile(path.join(root, "somewhere-else", "file.txt"), "x\n", "utf8");
  await writeUnsafeState("claude", ["somewhere-else/file.txt"]);
  const doctor = await doctorInstall(root, "claude");
  expect(doctor.ok).toBe(false);
  expect(doctor.invalidState.length).toBeGreaterThan(0);
});

test("F17: a corrupt/unparseable install-state file is reported as invalid, not read as empty", async () => {
  const file = skillsInstallStatePath(root, "claude");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{ this is not json", "utf8");

  const doctor = await doctorInstall(root, "claude");
  expect(doctor.ok).toBe(false);
  expect(doctor.invalidState.length).toBeGreaterThan(0);

  const uninstall = await uninstallInstall(root, "claude");
  expect(uninstall.ok).toBe(false);
  expect(uninstall.error).toBeDefined();

  const plan = await planInstall({ manifest: MANIFEST, profileId: "base", target: "claude", repoRoot: root });
  const applied = await applyInstall(plan, root);
  expect(applied.ok).toBe(false);
  expect(applied.errors.length).toBeGreaterThan(0);
});

/**
 * R2-1 regression: review round 2's `trav2.ts` repro recorded
 * `.claude/skills/../../package.json` — it resolves to `<root>/package.json`
 * (inside root) and textually STARTS WITH `.claude/skills/`, which round
 * 1's string-prefix destination-root check accepted. `doctor` then hashed
 * `package.json` as "ok", and `uninstall`/`uninstall --force` deleted it.
 * The repo-relative repository file used here stands in for `package.json`.
 */
test("R2-1: doctor refuses and uninstall (with or without --force) deletes nothing for a `..`-laundered path that textually starts with a destination root", async () => {
  const targetFile = path.join(root, "package.json");
  await writeFile(targetFile, '{"name":"victim"}\n', "utf8");
  await writeUnsafeState("claude", [".claude/skills/../../package.json"]);

  const doctor = await doctorInstall(root, "claude");
  expect(doctor.ok).toBe(false);
  expect(doctor.entries).toEqual([]);
  expect(doctor.invalidState.length).toBeGreaterThan(0);

  const result = await uninstallInstall(root, "claude");
  expect(result.ok).toBe(false);
  expect(result.removed).toEqual([]);
  expect(result.error).toBeDefined();
  await expect(readFile(targetFile, "utf8")).resolves.toBe('{"name":"victim"}\n');

  const forced = await uninstallInstall(root, "claude", { force: true });
  expect(forced.ok).toBe(false);
  expect(forced.removed).toEqual([]);
  await expect(readFile(targetFile, "utf8")).resolves.toBe('{"name":"victim"}\n');
});

test("R2-1: uninstall --force deletes nothing for a `..`-laundered path reaching .git/config", async () => {
  await mkdir(path.join(root, ".git"), { recursive: true });
  const gitConfig = path.join(root, ".git", "config");
  await writeFile(gitConfig, "[core]\n", "utf8");
  await writeUnsafeState("claude", [".claude/skills/../../.git/config"]);

  const forced = await uninstallInstall(root, "claude", { force: true });
  expect(forced.ok).toBe(false);
  expect(forced.removed).toEqual([]);
  await expect(readFile(gitConfig, "utf8")).resolves.toBe("[core]\n");
});

test("R2-1: doctor refuses a path under a same-prefixed sibling directory (`.claude/skillsX`) confused for the real destination root", async () => {
  await mkdir(path.join(root, ".claude", "skillsX"), { recursive: true });
  await writeFile(path.join(root, ".claude", "skillsX", "evil.mdc"), "x\n", "utf8");
  await writeUnsafeState("claude", [".claude/skillsX/evil.mdc"]);
  const doctor = await doctorInstall(root, "claude");
  expect(doctor.ok).toBe(false);
  expect(doctor.invalidState.length).toBeGreaterThan(0);
});

/**
 * R2-2 regression: review round 2's `leaf.ts` repro showed `apply --force`
 * writing THROUGH a destination file that is itself a symlink pointing
 * outside the project — round 1's symlink guard only checked the nearest
 * existing ANCESTOR directory, never the leaf. The plan's own destination
 * must be refused (skipped, not force-written) when it is a symlink.
 */
test("R2-2: apply --force refuses to write through a symlinked destination leaf; the symlink's target is left untouched", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "keryx-outside-"));
  try {
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "original outside content\n", "utf8");
    await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
    await symlink(victim, path.join(root, ".claude", "rules", "a.mdc"));

    const plan = await planInstall({ manifest: MANIFEST, profileId: "base", target: "claude", repoRoot: root });
    expect(plan.ok).toBe(true);
    const result = await applyInstall(plan, root, { force: true });

    expect(result.ok).toBe(false);
    expect(result.written).not.toContain(".claude/rules/a.mdc");
    expect(result.skipped.some((s) => s.path === ".claude/rules/a.mdc")).toBe(true);
    await expect(readFile(victim, "utf8")).resolves.toBe("original outside content\n");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

/**
 * R2-7 regression: the orphan scan is bounded to this target's destination
 * roots, but those roots can legitimately hold files the operator authored
 * by hand (never installed by Keryx). Such a file is reported `orphaned`
 * but must not make `doctor` fail.
 */
test("R2-7: doctor reports a hand-authored file under a destination root as orphaned but stays ok", async () => {
  await mkdir(path.join(root, ".claude", "rules"), { recursive: true });
  await writeFile(path.join(root, ".claude", "rules", "my-own.md"), "the operator's own file\n", "utf8");

  const doctor = await doctorInstall(root, "claude");
  expect(doctor.ok).toBe(true);
  const byPath = new Map(doctor.entries.map((e) => [e.path, e.status]));
  expect(byPath.get(".claude/rules/my-own.md")).toBe("orphaned");
});

test("F17: doctor's orphan scan roots include the stack-pack-namespaced rules root for keryx-shell (shared with the planner's destination table)", async () => {
  const manifest: InstallManifest = {
    schemaVersion: "1.0.0",
    profiles: { stackrule: { description: "stack rule", modules: ["stack-rule"], components: [] } },
    modules: {
      "stack-rule": {
        kind: "rule",
        description: "a stack-pack rule",
        paths: ["src/gdskills/bundled/stacks/fixture-lang/rules/coding-style.mdc"],
        targets: ["keryx-shell"],
        dependencies: [],
        defaultInstall: true,
        cost: "light",
        stability: "stable",
      },
    },
    components: {},
  };
  await mkdir(path.join(root, "src", "gdskills", "bundled", "stacks", "fixture-lang", "rules"), { recursive: true });
  await writeFile(
    path.join(root, "src", "gdskills", "bundled", "stacks", "fixture-lang", "rules", "coding-style.mdc"),
    "x\n",
    "utf8",
  );
  const plan = await planInstall({ manifest, profileId: "stackrule", target: "keryx-shell", repoRoot: root });
  expect(plan.ok).toBe(true);
  await applyInstall(plan, root);

  // An unrecorded file dropped directly into the stack-namespaced rules root
  // must show up as orphaned — proving doctor's orphan scan actually walks
  // that root, not just the bare `.metaproject/rules/core`.
  await mkdir(path.join(root, ".metaproject", "rules", "stacks", "fixture-lang"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "rules", "stacks", "fixture-lang", "extra.mdc"),
    "not recorded\n",
    "utf8",
  );
  const doctor = await doctorInstall(root, "keryx-shell");
  const byPath = new Map(doctor.entries.map((e) => [e.path, e.status]));
  expect(byPath.get(".metaproject/rules/stacks/fixture-lang/extra.mdc")).toBe("orphaned");
});
