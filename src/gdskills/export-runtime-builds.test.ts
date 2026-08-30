import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  HARNESS_SKILL_RUNTIMES,
  SKILL_RUNTIMES,
  exportProjectSkill,
  normalizeSkillRuntime,
  resolveSkillBuild,
  skillBuildFileName,
  type HarnessSkillRuntime,
} from "./export";

/**
 * Flow 205: every harness build must actually reach its harness.
 *
 * `job-orchestrator` ships five builds — SKILL.md, SKILL.codex.md,
 * SKILL.cursor.md, SKILL.opencode.md, SKILL.zed.md — and before this flow
 * `exportProjectSkill` copied SKILL.md for every runtime. `--runtime codex`
 * shipped the Claude build with the Codex build sitting unread beside it, and
 * `SkillRuntime` did not model cursor, zed or opencode at all.
 *
 * These tests drive the real `exportProjectSkill` over a real temp tree.
 */

const BUILD_MARKER = (runtime: string) => `THIS IS THE ${runtime.toUpperCase()} BUILD`;

type Fixture = { root: string; packageRoot: string };

/**
 * A minimal but real project skill package: `.metaproject/` so the export
 * passes its initialization check, plus a skill directory carrying whichever
 * builds the caller asked for.
 */
async function makeFixture(builds: string[]): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-export-builds-"));
  const packageRoot = path.join(root, ".metaproject", "project-skills", "orchestration", "demo-skill");
  await mkdir(packageRoot, { recursive: true });
  for (const build of builds) {
    const runtime = build === "SKILL.md" ? "claude" : build.slice("SKILL.".length, -".md".length);
    await writeFile(path.join(packageRoot, build), `# demo-skill\n\n${BUILD_MARKER(runtime)}\n`, "utf8");
  }
  return { root, packageRoot };
}

const ALL_BUILDS = ["SKILL.md", "SKILL.codex.md", "SKILL.cursor.md", "SKILL.zed.md", "SKILL.opencode.md"];

test("SkillRuntime models every harness that ships a build, plus plugin", () => {
  // The denominator: five harnesses. If this list ever shrinks silently, a
  // build stops being exportable and the sweeps below get quieter, not redder.
  expect(HARNESS_SKILL_RUNTIMES.length).toBe(5);
  expect([...HARNESS_SKILL_RUNTIMES].sort()).toEqual(["claude", "codex", "cursor", "opencode", "zed"]);
  // `plugin` is not a harness — it is the marketplace package layout — but it
  // is load-bearing: exportProjectSkill branches to exportPluginSkill on it.
  expect(SKILL_RUNTIMES).toContain("plugin");

  for (const runtime of [...SKILL_RUNTIMES]) {
    expect(normalizeSkillRuntime(runtime)).toBe(runtime);
  }
  expect(normalizeSkillRuntime("antigravity")).toBeUndefined();
  expect(normalizeSkillRuntime(undefined)).toBeUndefined();
  expect(normalizeSkillRuntime("")).toBeUndefined();
});

test("each harness runtime owns its own build filename", () => {
  expect(skillBuildFileName("claude")).toBe("SKILL.md");
  expect(skillBuildFileName("codex")).toBe("SKILL.codex.md");
  expect(skillBuildFileName("cursor")).toBe("SKILL.cursor.md");
  expect(skillBuildFileName("zed")).toBe("SKILL.zed.md");
  expect(skillBuildFileName("opencode")).toBe("SKILL.opencode.md");
});

test("export copies the runtime's OWN build when the skill ships one", async () => {
  const { root, packageRoot } = await makeFixture(ALL_BUILDS);
  try {
    // Sweep every harness runtime, and assert the denominator so a shrunken
    // HARNESS_SKILL_RUNTIMES cannot make this test pass by iterating nothing.
    const runtimes: HarnessSkillRuntime[] = [...HARNESS_SKILL_RUNTIMES];
    expect(runtimes.length).toBe(5);

    for (const runtime of runtimes) {
      const result = await exportProjectSkill(root, { input: packageRoot, runtime });

      expect(result.sourceBuild).toBe(skillBuildFileName(runtime));
      expect(result.usedFallbackBuild).toBe(false);

      // The bytes that actually landed, not just the label on them.
      const exported = await readFile(path.join(root, result.outputPath, "SKILL.md"), "utf8");
      expect(exported).toContain(BUILD_MARKER(runtime));
      for (const other of runtimes.filter((candidate) => candidate !== runtime)) {
        expect(exported).not.toContain(BUILD_MARKER(other));
      }

      const manifest = JSON.parse(
        await readFile(path.join(root, result.outputPath, "export-manifest.json"), "utf8"),
      ) as { sourceBuild: string; usedFallbackBuild: boolean };
      expect(manifest.sourceBuild).toBe(skillBuildFileName(runtime));
      expect(manifest.usedFallbackBuild).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export falls back to SKILL.md when a runtime has no build, and says so", async () => {
  const { root, packageRoot } = await makeFixture(["SKILL.md"]);
  try {
    const runtimes: HarnessSkillRuntime[] = [...HARNESS_SKILL_RUNTIMES];
    expect(runtimes.length).toBe(5);

    for (const runtime of runtimes) {
      const result = await exportProjectSkill(root, { input: packageRoot, runtime });
      expect(result.sourceBuild).toBe("SKILL.md");
      // claude's own build IS SKILL.md, so it is not a fallback for claude.
      expect(result.usedFallbackBuild).toBe(runtime !== "claude");
      expect(await readFile(path.join(root, result.outputPath, "SKILL.md"), "utf8"))
        .toContain(BUILD_MARKER("claude"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export picks per-runtime: a partial build set falls back only where it must", async () => {
  // The realistic middle case a blanket rule would get wrong.
  const { root, packageRoot } = await makeFixture(["SKILL.md", "SKILL.codex.md"]);
  try {
    const codex = await exportProjectSkill(root, { input: packageRoot, runtime: "codex" });
    expect(codex.sourceBuild).toBe("SKILL.codex.md");
    expect(codex.usedFallbackBuild).toBe(false);
    expect(await readFile(path.join(root, codex.outputPath, "SKILL.md"), "utf8"))
      .toContain(BUILD_MARKER("codex"));

    const zed = await exportProjectSkill(root, { input: packageRoot, runtime: "zed" });
    expect(zed.sourceBuild).toBe("SKILL.md");
    expect(zed.usedFallbackBuild).toBe(true);
    expect(await readFile(path.join(root, zed.outputPath, "SKILL.md"), "utf8"))
      .toContain(BUILD_MARKER("claude"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveSkillBuild refuses a package with no SKILL.md at all", async () => {
  const { root, packageRoot } = await makeFixture(["SKILL.codex.md"]);
  try {
    await expect(resolveSkillBuild(packageRoot, "zed")).rejects.toThrow(/no SKILL\.md/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dry-run export reports the build it would use without writing it", async () => {
  const { root, packageRoot } = await makeFixture(ALL_BUILDS);
  try {
    const result = await exportProjectSkill(root, { input: packageRoot, runtime: "cursor", dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.sourceBuild).toBe("SKILL.cursor.md");
    expect(result.files.length).toBeGreaterThan(0);
    await expect(readFile(path.join(root, result.outputPath, "SKILL.md"), "utf8")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
