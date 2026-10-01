// Flow 363 (AC1–AC3, AC6): the Claude and Codex rules-export surfaces follow
// `agentEntrypoints.root` — `CLAUDE.local.md` / `AGENTS.override.md` under
// scope local, the tracked `CLAUDE.md` / `AGENTS.md` only under scope shared
// — and every entry point (install, uninstall, integrations doctor, inspect,
// --dry-run, install-state, `bundle import --render-for`) names the same file.
//
// Every fixture is a real temp git repository whose `core.excludesFile`
// points at a file that does not exist, so the developer's own global
// excludes cannot answer for it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderCodexOverride } from "../rules/entrypoint-writers";
import { readInstallState } from "./install-state";
import { doctorIntegration, installIntegration, uninstallIntegration } from "./installer";
import { getHarnessAdapter, surfaceRelativePath } from "./registry";
import { renderRulesForHarnesses } from "./rules-export";

const RULES_START = "<!-- keryx:rules -->";
const INDEX_BLOCK = "<!-- keryx:index -->\nRead .metaproject/index.md first.\n<!-- /keryx:index -->\n";
const AGENTS = "# Team\n\nUse the team rules.\n";
const CLAUDE = "# Claude\n\nPrefer compact context.\n";
const LOCAL_CLAUDE = { runtime: "claude", path: "CLAUDE.local.md", scope: "local" };
const LOCAL_CODEX = { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" };
const SHARED_CLAUDE = { runtime: "claude", path: "CLAUDE.md", scope: "shared" };
const SHARED_CODEX = { runtime: "codex", path: "AGENTS.md", scope: "shared" };
const LOCAL_SETTINGS = { path: ".claude/settings.local.json", scope: "local" };

let root: string;

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

async function writeRel(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content, "utf8");
}

async function readRel(rel: string): Promise<string> {
  return readFile(path.join(root, rel), "utf8");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A committed repository: the team files, one canonical rule, and a manifest naming `root` entries. */
async function fixture(rootEntries: unknown[]): Promise<void> {
  git(["init", "-q"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "user.name", "test"]);
  git(["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
  await writeRel(".metaproject/metaproject.json", `${JSON.stringify({ modules: {}, agentEntrypoints: { root: rootEntries, claudeSettings: LOCAL_SETTINGS } }, null, 2)}\n`);
  await writeRel(".metaproject/rules/core/git-concurrency.mdc", '---\ndescription: "No git stash in a shared tree."\n---\n\n# Git\n');
  await writeRel("AGENTS.md", AGENTS);
  await writeRel("CLAUDE.md", CLAUDE);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
}

/** `AGENTS.override.md` as `keryx update` generates it. */
async function writeKeryxOverride(): Promise<string> {
  const content = renderCodexOverride({ source: "AGENTS.md", sourceContent: AGENTS, block: INDEX_BLOCK });
  await writeRel("AGENTS.override.md", content);
  return content;
}

function statusLines(): string[] {
  return git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter((line) => line.length > 0);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-rules-export-entry-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("flow 363 AC1: with local scopes the block goes to CLAUDE.local.md and AGENTS.override.md", () => {
  test("install writes the local files, git status names neither team file nor a local file, and uninstall removes the block from the same files", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    const override = await writeKeryxOverride();

    const claude = await installIntegration(root, "claude", { surfaces: ["rules"] });
    expect(claude.errors).toEqual([]);
    expect(claude.results[0]).toMatchObject({ surfaceId: "rules-export", status: "installed", file: "CLAUDE.local.md" });
    const codex = await installIntegration(root, "codex", { surfaces: ["rules"] });
    expect(codex.errors).toEqual([]);
    expect(codex.results[0]).toMatchObject({ surfaceId: "rules-export", status: "installed", file: "AGENTS.override.md" });

    expect(await readRel("CLAUDE.local.md")).toContain("git-concurrency.mdc");
    expect(count(await readRel("AGENTS.override.md"), RULES_START)).toBe(1);
    expect(await readRel("CLAUDE.md")).toBe(CLAUDE);
    expect(await readRel("AGENTS.md")).toBe(AGENTS);
    const status = statusLines();
    for (const file of ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", "AGENTS.override.md"]) {
      expect(status.some((line) => line.endsWith(` ${file}`))).toBe(false);
    }

    const claudeOut = await uninstallIntegration(root, "claude", { surfaces: ["rules"] });
    expect(claudeOut.results[0]).toMatchObject({ status: "removed", file: "CLAUDE.local.md" });
    const codexOut = await uninstallIntegration(root, "codex", { surfaces: ["rules"] });
    expect(codexOut.results[0]).toMatchObject({ status: "removed", file: "AGENTS.override.md" });
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
    expect(await readRel("AGENTS.override.md")).toBe(override);
    expect(await readRel("CLAUDE.md")).toBe(CLAUDE);
    expect(await readRel("AGENTS.md")).toBe(AGENTS);
  });

  test("a CLAUDE.local.md the developer already has keeps its lines; only the block is added and removed", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    const mine = `# Local Claude Instructions\n\n${INDEX_BLOCK}\nMy sandbox is http://localhost:4000.\n`;
    await writeRel("CLAUDE.local.md", mine);

    await installIntegration(root, "claude", { surfaces: ["rules"] });
    const installed = await readRel("CLAUDE.local.md");
    expect(installed.startsWith(mine)).toBe(true);
    expect(count(installed, RULES_START)).toBe(1);

    await uninstallIntegration(root, "claude", { surfaces: ["rules"] });
    expect(await readRel("CLAUDE.local.md")).toBe(mine);
  });
});

describe("flow 363 AC2: scope shared keeps writing the tracked team files", () => {
  test("CLAUDE.md and AGENTS.md get the block exactly as before 0.3.46, and uninstall restores them byte for byte", async () => {
    await fixture([SHARED_CLAUDE, SHARED_CODEX]);

    for (const [runtime, file] of [["claude", "CLAUDE.md"], ["codex", "AGENTS.md"]] as const) {
      const result = await installIntegration(root, runtime, { surfaces: ["rules"] });
      expect(result.results[0]).toMatchObject({ status: "installed", file });
    }
    const claude = await readRel("CLAUDE.md");
    expect(claude).toBe(`${CLAUDE}\n${claude.slice(CLAUDE.length + 1)}`);
    expect(claude.slice(CLAUDE.length + 1).startsWith(RULES_START)).toBe(true);
    expect(await readRel("AGENTS.md")).toContain("git-concurrency.mdc");
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);

    await uninstallIntegration(root, "claude", { surfaces: ["rules"] });
    await uninstallIntegration(root, "codex", { surfaces: ["rules"] });
    expect(await readRel("CLAUDE.md")).toBe(CLAUDE);
    expect(await readRel("AGENTS.md")).toBe(AGENTS);
  });

  test("switching Claude to shared moves the block: the copy left in CLAUDE.local.md is removed, so it is never in both", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    await installIntegration(root, "claude", { surfaces: ["rules"] });
    expect(await readRel("CLAUDE.local.md")).toContain(RULES_START);
    const manifestPath = ".metaproject/metaproject.json";
    await writeRel(manifestPath, (await readRel(manifestPath)).replace('"path": "CLAUDE.local.md",\n        "scope": "local"', '"path": "CLAUDE.md",\n        "scope": "shared"'));

    const result = await installIntegration(root, "claude", { surfaces: ["rules"] });

    expect(result.results[0]).toMatchObject({ status: "installed", file: "CLAUDE.md" });
    expect(count(await readRel("CLAUDE.md"), RULES_START)).toBe(1);
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
  });
});

describe("flow 363 AC3: no Codex target writes nothing and succeeds with a warning", () => {
  test('mode "skip"', async () => {
    await fixture([LOCAL_CLAUDE, { ...LOCAL_CODEX, mode: "skip" }]);
    const result = await installIntegration(root, "codex", { surfaces: ["rules"] });
    expect(result.errors).toEqual([]);
    // Flow 363 end-to-end check: nothing was written, so the status says so.
    expect(result.results[0]!.status).toBe("skipped");
    expect(result.results[0]!.file).toBeUndefined();
    expect(result.results[0]!.warnings.join("\n")).toContain('mode "skip"');
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(await readRel("AGENTS.md")).toBe(AGENTS);
    expect((await readInstallState(root, "codex"))?.installedModules.some((record) => record.moduleId === "rules-export") ?? false).toBe(false);
  });

  test("no AGENTS.md", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    git(["rm", "-q", "AGENTS.md"]);
    git(["commit", "-q", "-m", "drop AGENTS.md"]);
    const result = await installIntegration(root, "codex", { surfaces: ["rules"] });
    expect(result.errors).toEqual([]);
    expect(result.results[0]!.warnings.join("\n")).toContain("AGENTS.md does not exist");
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
  });

  test("an AGENTS.override.md keryx did not generate is left untouched", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    const theirs = "# My own Codex override\n";
    await writeRel("AGENTS.override.md", theirs);
    const result = await installIntegration(root, "codex", { surfaces: ["rules"] });
    expect(result.errors).toEqual([]);
    expect(result.results[0]!.warnings.join("\n")).toContain("not generated by keryx");
    expect(await readRel("AGENTS.override.md")).toBe(theirs);
    expect(await readRel("AGENTS.md")).toBe(AGENTS);
  });

  test("the dry run and bundle --render-for report the same reason and write nothing", async () => {
    await fixture([LOCAL_CLAUDE, { ...LOCAL_CODEX, mode: "skip" }]);
    const dryRun = await installIntegration(root, "codex", { surfaces: ["rules"], dryRun: true });
    expect(dryRun.results[0]!.status).toBe("skipped");
    expect(dryRun.results[0]!.warnings.join("\n")).toContain('mode "skip"');
    const rendered = await renderRulesForHarnesses(root, ["codex"]);
    expect(rendered[0]).toMatchObject({ harness: "codex", status: "unchanged" });
    expect(rendered[0]!.file).toBeUndefined();
    expect(rendered[0]!.messages.join("\n")).toContain('mode "skip"');
    expect(await readRel("AGENTS.md")).toBe(AGENTS);
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
  });
});

describe("flow 363 AC6: every entry point names the same resolved file", () => {
  test("dry run, install, install-state, inspect, integrations doctor and uninstall all use CLAUDE.local.md / AGENTS.override.md", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    await writeKeryxOverride();
    const expected = { claude: "CLAUDE.local.md", codex: "AGENTS.override.md" } as const;

    for (const runtime of ["claude", "codex"] as const) {
      const surface = getHarnessAdapter(runtime)!.surfaces.find((candidate) => candidate.id === "rules-export")!;
      expect(surfaceRelativePath(surface, root)).toBe(expected[runtime]);
      expect(surface.settingsFile!(root)).toBe(path.join(root, expected[runtime]));

      const dryRun = await installIntegration(root, runtime, { surfaces: ["rules"], dryRun: true });
      expect(dryRun.results[0]).toMatchObject({ status: "would-install", file: expected[runtime] });
      expect(await surface.inspect!(root)).toMatchObject({ state: runtime === "claude" ? "absent-file" : "no-block" });

      await installIntegration(root, runtime, { surfaces: ["rules"] });
      const record = (await readInstallState(root, runtime))?.installedModules.find((entry) => entry.moduleId === "rules-export");
      expect(record?.writtenPaths).toEqual([expected[runtime]]);
      expect(await surface.inspect!(root)).toEqual({ state: "present" });

      const doctor = await doctorIntegration(root, runtime, { surfaces: ["rules"] });
      expect(doctor.surfaces.find((entry) => entry.surfaceId === "rules-export")).toMatchObject({ live: "valid", problems: [] });

      const dryUninstall = await uninstallIntegration(root, runtime, { surfaces: ["rules"], dryRun: true });
      expect(dryUninstall.results[0]).toMatchObject({ status: "would-remove", file: expected[runtime] });
    }

    // The tracked files never got the block.
    expect(await readRel("CLAUDE.md")).toBe(CLAUDE);
    expect(await readRel("AGENTS.md")).toBe(AGENTS);

    // Doctor reads the resolved file: a block removed from it by hand is reported there.
    await writeRel("CLAUDE.local.md", "# Local Claude Instructions\n");
    const doctor = await doctorIntegration(root, "claude", { surfaces: ["rules"] });
    const problems = doctor.surfaces.find((entry) => entry.surfaceId === "rules-export")!.problems.join("\n");
    expect(problems).toContain("CLAUDE.local.md");
    expect(doctor.ok).toBe(false);
  });

  test("bundle --render-for renders into the resolved local files", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    await writeKeryxOverride();
    const results = await renderRulesForHarnesses(root, ["claude", "codex"]);
    expect(results.map((result) => [result.harness, result.status, result.file])).toEqual([
      ["claude", "installed", "CLAUDE.local.md"],
      ["codex", "installed", "AGENTS.override.md"],
    ]);
    expect(await readRel("CLAUDE.md")).toBe(CLAUDE);
    expect(await readRel("AGENTS.md")).toBe(AGENTS);
  });

  test("a block still in a tracked team file keeps the surface writing there until update moves it — never a second copy", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    await writeRel("CLAUDE.md", `${CLAUDE}\n${RULES_START}\nold\n<!-- /keryx:rules -->\n`);

    const result = await installIntegration(root, "claude", { surfaces: ["rules"] });

    expect(result.results[0]).toMatchObject({ status: "installed", file: "CLAUDE.md" });
    expect(count(await readRel("CLAUDE.md"), RULES_START)).toBe(1);
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
  });
});

// Flow 363 review round 1. Each test is the reproduction the verifier ran
// (`scratchpad/r363/repro*.ts`, `scratchpad/t363/s5c`), as a real temp repo.
const TEAM_RULES = `${RULES_START}\n- the team's committed rule list\n<!-- /keryx:rules -->\n`;

describe("flow 363 review F-001: a cloned manifest cannot point the block at another file", () => {
  test("a shared path naming .env, or a Codex source naming package.json, is never written", async () => {
    await fixture([{ runtime: "claude", scope: "shared", path: ".env" }, { ...LOCAL_CODEX, source: "package.json" }]);
    await writeRel(".gitignore", ".env\n");
    await writeRel(".env", "API_KEY=secret\n");
    await writeRel("package.json", '{ "name": "x" }\n');

    const claude = await installIntegration(root, "claude", { surfaces: ["rules"] });
    const codex = await installIntegration(root, "codex", { surfaces: ["rules"] });

    expect(claude.errors).toEqual([]);
    expect(codex.errors).toEqual([]);
    expect(await readRel(".env")).toBe("API_KEY=secret\n");
    expect(await readRel("package.json")).toBe('{ "name": "x" }\n');
    // Junk entries fall back to the team file, as an unsettled legacy entry does.
    expect(claude.results[0]!.file).toBe("CLAUDE.md");
    expect(codex.results[0]!.file).toBe("AGENTS.md");
  });

  test("a shared path naming the manifest leaves the manifest byte for byte", async () => {
    await fixture([{ runtime: "claude", scope: "shared", path: ".metaproject/metaproject.json" }, LOCAL_CODEX]);
    const manifest = await readRel(".metaproject/metaproject.json");
    const result = await installIntegration(root, "claude", { surfaces: ["rules"] });
    expect(result.errors).toEqual([]);
    expect(await readRel(".metaproject/metaproject.json")).toBe(manifest);
    expect(result.results[0]!.file).toBe("CLAUDE.md");
  });
});

describe("flow 363 review F-003: only keryx's own slot in AGENTS.override.md is carried, written or removed", () => {
  test("a block the team removed from AGENTS.md is not resurrected by the next regeneration", () => {
    const teamWithBlock = `${AGENTS}\n${TEAM_RULES}`;
    const before = renderCodexOverride({ source: "AGENTS.md", sourceContent: teamWithBlock, block: INDEX_BLOCK });
    expect(count(before, RULES_START)).toBe(1);
    const after = renderCodexOverride({ source: "AGENTS.md", sourceContent: AGENTS, block: INDEX_BLOCK, previous: before });
    expect(count(after, RULES_START)).toBe(0);
    expect(after).toBe(renderCodexOverride({ source: "AGENTS.md", sourceContent: AGENTS, block: INDEX_BLOCK }));
  });

  test("a block keryx installed in its slot is still carried across a regeneration", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    await writeKeryxOverride();
    await installIntegration(root, "codex", { surfaces: ["rules"] });
    const installed = await readRel("AGENTS.override.md");
    const revised = `${AGENTS}\nMore team text.\n`;
    const regenerated = renderCodexOverride({ source: "AGENTS.md", sourceContent: revised, block: INDEX_BLOCK, previous: installed });
    expect(count(regenerated, RULES_START)).toBe(1);
    expect(regenerated.endsWith(revised)).toBe(true);
  });

  test("with the block committed in AGENTS.md, install and uninstall never edit the override's copy of it (end-to-end check s5c)", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    const team = `${AGENTS}\n${TEAM_RULES}`;
    await writeRel("AGENTS.md", team);
    git(["commit", "-q", "-am", "team commits the rules block"]);
    const override = renderCodexOverride({ source: "AGENTS.md", sourceContent: team, block: INDEX_BLOCK });
    await writeRel("AGENTS.override.md", override);

    const install = await installIntegration(root, "codex", { surfaces: ["rules"] });
    expect(install.results[0]).toMatchObject({ status: "installed", file: "AGENTS.md" });
    expect(install.results[0]!.warnings.join("\n")).not.toContain("AGENTS.override.md");
    // Byte for byte: the copy, and so the provenance hash it was recorded with, are untouched.
    expect(await readRel("AGENTS.override.md")).toBe(override);

    const dryUninstall = await uninstallIntegration(root, "codex", { surfaces: ["rules"], dryRun: true });
    expect(dryUninstall.results[0]!.warnings.join("\n")).not.toContain("AGENTS.override.md");
    await uninstallIntegration(root, "codex", { surfaces: ["rules"] });
    expect(await readRel("AGENTS.override.md")).toBe(override);
  });

  test("a stale copy of a block in the override's team text is left alone; install and uninstall touch only the slot", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    // Generated while AGENTS.md still carried the block; the team has removed it since.
    const stale = renderCodexOverride({ source: "AGENTS.md", sourceContent: `${AGENTS}\n${TEAM_RULES}`, block: INDEX_BLOCK });
    await writeRel("AGENTS.override.md", stale);

    const install = await installIntegration(root, "codex", { surfaces: ["rules"] });
    expect(install.results[0]).toMatchObject({ status: "installed", file: "AGENTS.override.md" });
    const installed = await readRel("AGENTS.override.md");
    expect(installed.endsWith(`${AGENTS}\n${TEAM_RULES}`)).toBe(true);
    expect(installed.indexOf(RULES_START)).toBeLessThan(installed.indexOf("# Team"));
    expect(count(installed, "the team's committed rule list")).toBe(1);

    await uninstallIntegration(root, "codex", { surfaces: ["rules"] });
    expect(await readRel("AGENTS.override.md")).toBe(stale);
  });
});

describe("flow 363 review F-004: a tracked CLAUDE.local.md is the team's and is never written", () => {
  test("install writes nothing, says how to fix it, and git status stays clean", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    await writeRel("CLAUDE.local.md", "# Team-owned local\n");
    git(["add", "CLAUDE.local.md"]);
    git(["commit", "-q", "-m", "team tracks CLAUDE.local.md"]);

    const dryRun = await installIntegration(root, "claude", { surfaces: ["rules"], dryRun: true });
    expect(dryRun.results[0]!.warnings.join("\n")).toContain("git rm --cached CLAUDE.local.md");
    const result = await installIntegration(root, "claude", { surfaces: ["rules"] });

    expect(result.errors).toEqual([]);
    expect(result.results[0]!.status).toBe("skipped");
    expect(result.results[0]!.file).toBeUndefined();
    expect(result.results[0]!.warnings.join("\n")).toContain("git rm --cached CLAUDE.local.md");
    expect(await readRel("CLAUDE.local.md")).toBe("# Team-owned local\n");
    expect(await readRel("CLAUDE.md")).toBe(CLAUDE);
    expect(statusLines()).toEqual([]);
  });
});

describe("flow 363 end-to-end check: uninstall --dry-run names the cleanup a real run does", () => {
  test("a block keryx left in AGENTS.override.md is named by the dry run and removed by the real run", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    const override = await writeKeryxOverride();
    await installIntegration(root, "codex", { surfaces: ["rules"] });
    // The team then commits a block in AGENTS.md: the surface follows it there.
    await writeRel("AGENTS.md", `${AGENTS}\n${TEAM_RULES}`);
    git(["commit", "-q", "-am", "team commits the rules block"]);

    const dryRun = await uninstallIntegration(root, "codex", { surfaces: ["rules"], dryRun: true });
    expect(dryRun.results[0]).toMatchObject({ status: "would-remove", file: "AGENTS.md" });
    expect(dryRun.results[0]!.warnings.join("\n")).toContain("AGENTS.override.md");
    expect(count(await readRel("AGENTS.override.md"), RULES_START)).toBe(1);

    const real = await uninstallIntegration(root, "codex", { surfaces: ["rules"] });
    expect(real.results[0]!.warnings.join("\n")).toContain("AGENTS.override.md");
    expect(await readRel("AGENTS.override.md")).toBe(override);
  });

  test("a block left in CLAUDE.local.md after a switch to shared makes the dry run report would-remove", async () => {
    await fixture([LOCAL_CLAUDE, LOCAL_CODEX]);
    await installIntegration(root, "claude", { surfaces: ["rules"] });
    const manifestPath = ".metaproject/metaproject.json";
    await writeRel(manifestPath, (await readRel(manifestPath)).replace('"path": "CLAUDE.local.md",\n        "scope": "local"', '"path": "CLAUDE.md",\n        "scope": "shared"'));

    const dryRun = await uninstallIntegration(root, "claude", { surfaces: ["rules"], dryRun: true });
    expect(dryRun.results[0]).toMatchObject({ status: "would-remove", file: "CLAUDE.md" });
    expect(dryRun.results[0]!.warnings.join("\n")).toContain("CLAUDE.local.md");
    const real = await uninstallIntegration(root, "claude", { surfaces: ["rules"] });
    expect(real.results[0]!.status).toBe("removed");
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
  });
});
