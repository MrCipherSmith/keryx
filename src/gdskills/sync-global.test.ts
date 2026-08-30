import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  GLOBAL_SKILL_SYNC_TARGETS,
  GLOBAL_SYNC_RUNTIMES,
  resolveGlobalSyncTarget,
  syncRuntimeSkills,
  syncRuntimeSkillsToGlobal,
} from "./sync";

/**
 * Flow 205: the Global Sync Mapping that
 * `src/gdskills/bundled/rules/core/skills-storage-workflow.mdc` has documented
 * all along, and that no code implemented.
 *
 * Every test here uses a temp HOME. Nothing in this file may write into the
 * operator's real home directory — that is the whole hazard the "refuse rather
 * than create" rule exists to contain.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** A project with one already-exported runtime skill, ready to sync. */
async function makeExportedProject(runtime: string): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sync-global-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const skillDir = path.join(root, "project", ".metaproject", "runtime", "skills", runtime, "orchestration-demo");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), `# demo (${runtime})\n`, "utf8");
  await writeFile(path.join(skillDir, "references", ".keep"), "", "utf8").catch(async () => {
    await mkdir(path.join(skillDir, "references"), { recursive: true });
    await writeFile(path.join(skillDir, "references", ".keep"), "", "utf8");
  });
  return { root, home };
}

function projectOf(root: string): string {
  return path.join(root, "project");
}

test("the global mapping names exactly the four destinations the rule documents", () => {
  // Denominator: four. `claude` and `plugin` are deliberately absent — the rule
  // names no home-directory destination for either.
  expect(GLOBAL_SYNC_RUNTIMES.length).toBe(4);
  expect(GLOBAL_SYNC_RUNTIMES).toEqual(["codex", "cursor", "opencode", "zed"]);
  expect(Object.hasOwn(GLOBAL_SKILL_SYNC_TARGETS, "claude")).toBe(false);

  const home = path.join(path.sep, "tmp", "fake-home");
  const env = { HOME: home };

  expect(resolveGlobalSyncTarget("cursor", env).skillsRoot).toBe(path.join(home, ".cursor", "skills"));
  expect(resolveGlobalSyncTarget("codex", env).skillsRoot).toBe(path.join(home, ".codex", "skills"));
  expect(resolveGlobalSyncTarget("zed", env).skillsRoot).toBe(path.join(home, ".config", "zed", "skills"));
  expect(resolveGlobalSyncTarget("opencode", env).skillsRoot).toBe(path.join(home, ".config", "opencode", "skills"));
});

test("codex honours CODEX_HOME, as the rule's ${CODEX_HOME:-~/.codex} says", () => {
  const home = path.join(path.sep, "tmp", "fake-home");
  const codexHome = path.join(path.sep, "tmp", "elsewhere", "codex");
  expect(resolveGlobalSyncTarget("codex", { HOME: home, CODEX_HOME: codexHome }).skillsRoot)
    .toBe(path.join(codexHome, "skills"));
  // An empty override is not an override.
  expect(resolveGlobalSyncTarget("codex", { HOME: home, CODEX_HOME: "" }).skillsRoot)
    .toBe(path.join(home, ".codex", "skills"));
});

test("claude and plugin have no global destination and say which runtimes do", () => {
  const env = { HOME: path.join(path.sep, "tmp", "fake-home") };
  for (const runtime of ["claude", "plugin"] as const) {
    expect(() => resolveGlobalSyncTarget(runtime, env)).toThrow(
      /No global sync destination is defined for runtime/,
    );
    expect(() => resolveGlobalSyncTarget(runtime, env)).toThrow(/codex, cursor, opencode, zed/);
  }
});

test("global sync refuses to create a harness home that does not exist", async () => {
  const { root, home } = await makeExportedProject("cursor");
  try {
    // `home` exists; `home/.cursor` does not. Nothing may be created.
    const promise = syncRuntimeSkillsToGlobal(projectOf(root), {
      runtime: "cursor",
      env: { HOME: home },
    });
    await expect(promise).rejects.toThrow(/Refusing to create/);
    await expect(promise).rejects.toThrow(path.join(home, ".cursor"));

    // Proof the refusal is a refusal: the tree is untouched.
    await expect(readFile(path.join(home, ".cursor", "skills", "orchestration-demo", "SKILL.md"), "utf8"))
      .rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global sync writes into a temp HOME when the harness home exists", async () => {
  const { root, home } = await makeExportedProject("zed");
  try {
    // The user has zed installed: ~/.config/zed exists. `skills/` beneath it
    // is ours to create.
    await mkdir(path.join(home, ".config", "zed"), { recursive: true });

    const result = await syncRuntimeSkillsToGlobal(projectOf(root), {
      runtime: "zed",
      env: { HOME: home },
    });

    expect(result.mode).toBe("global-mapping");
    expect(result.targetRoot).toBe(path.join(home, ".config", "zed", "skills"));
    expect(result.syncedSkills).toEqual(["orchestration-demo"]);
    expect(result.files.length).toBeGreaterThan(1);

    expect(await readFile(path.join(home, ".config", "zed", "skills", "orchestration-demo", "SKILL.md"), "utf8"))
      .toContain("# demo (zed)");

    const manifest = JSON.parse(
      await readFile(path.join(home, ".config", "zed", "skills", "keryx-sync-manifest.json"), "utf8"),
    ) as { mode: string; runtime: string };
    expect(manifest.mode).toBe("global-mapping");
    expect(manifest.runtime).toBe("zed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dry-run global sync plans the write without performing it", async () => {
  const { root, home } = await makeExportedProject("opencode");
  try {
    await mkdir(path.join(home, ".config", "opencode"), { recursive: true });
    const result = await syncRuntimeSkillsToGlobal(projectOf(root), {
      runtime: "opencode",
      dryRun: true,
      env: { HOME: home },
    });

    expect(result.dryRun).toBe(true);
    expect(result.files.length).toBeGreaterThan(1);
    await expect(readFile(path.join(home, ".config", "opencode", "skills", "orchestration-demo", "SKILL.md"), "utf8"))
      .rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit-target sync still works and is labelled as the other mode", async () => {
  const { root } = await makeExportedProject("codex");
  try {
    const result = await syncRuntimeSkills(projectOf(root), {
      runtime: "codex",
      target: ".metaproject/runtime/synced/codex",
    });
    expect(result.mode).toBe("explicit-target");
    expect(result.syncedSkills).toEqual(["orchestration-demo"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Global sync must be opt-in. `keryx update` runs unattended on every project
 * refresh; if it ever reached into `~/.cursor/` or `~/.config/zed/`, that would
 * be a side effect nobody asked for. This pins the call graph, not a comment.
 */
test("no implicit command performs a global sync", async () => {
  const callers = [
    path.join(REPO_ROOT, "src", "commands", "update.ts"),
    path.join(REPO_ROOT, "src", "commands", "init.ts"),
    path.join(REPO_ROOT, "src", "commands", "sync.ts"),
    path.join(REPO_ROOT, "src", "gdskills", "install.ts"),
  ];
  // Denominator: four files actually read. A typo'd path must not pass by
  // reading nothing.
  let inspected = 0;
  for (const file of callers) {
    const source = await readFile(file, "utf8");
    expect(source.length).toBeGreaterThan(0);
    inspected += 1;
    expect(source).not.toContain("syncRuntimeSkillsToGlobal");
    expect(source).not.toContain("resolveGlobalSyncTarget");
  }
  expect(inspected).toBe(4);

  // And the one place that may perform it does so behind an explicit flag.
  const skillsCommand = await readFile(path.join(REPO_ROOT, "src", "commands", "skills.ts"), "utf8");
  expect(skillsCommand).toContain("syncRuntimeSkillsToGlobal");
  expect(skillsCommand).toContain('args.includes("--global")');
});
