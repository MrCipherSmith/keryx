import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { RETIRED_RULES } from "../gdskills/retired-rules";
import { ContainedWriteError } from "../lib/contained-write";
import { memoryCommand } from "./memory";
import { defaultEntrypointTargets } from "../rules/entrypoint-targets";
import { initCommand } from "./init";
import { updateCommand } from "./update";

// Round-1 finding T-001: the retired-rule warning print was tested only at
// the `keryx skills install` call site (skills-install-warnings.test.ts).
// `installGdskills` is also called from `keryx init` (printed by its
// `Notices`/`Warnings` headings at the end of the scaffold summary) and
// `keryx update` (see update.test.ts) — a regression that silences either
// print stayed green under the old coverage. These tests drive `keryx init`
// directly.
const retiredFixturesRootForInit = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "gdskills",
  "__fixtures__",
  "retired-rules",
);

const MINIMAL_INIT_ARGS_KEEPING_GDSKILLS = [
  "--yes",
  "--no-gdgraph",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security",
];

/** Patches `console.log` to capture every call's stringified arguments. */
function captureInitConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function retiredEntryForInitOrThrow() {
  const retiredEntry = RETIRED_RULES[0];
  if (!retiredEntry) {
    throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
  }
  return retiredEntry;
}

test("keryx init: a modified retired rule prints a Warnings heading and the warning line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-retired-rules-"));
  try {
    const retiredEntry = retiredEntryForInitOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRootForInit, retiredEntry.fileName), "utf8");
    const modifiedContent = `${unmodifiedContent}\n<!-- project-local note added after install -->\n`;
    await writeFile(path.join(rulesCore, retiredEntry.fileName), modifiedContent, "utf8");

    const { logs, restore } = captureInitConsoleLog();
    try {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT_ARGS_KEEPING_GDSKILLS);
      });
    } finally {
      restore();
    }

    expect(await readFile(path.join(rulesCore, retiredEntry.fileName), "utf8")).toBe(modifiedContent);
    expect(logs.some((line) => line.includes("Warnings"))).toBe(true);
    expect(logs.some((line) => line.includes(
      `${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it differs from every shipped version — delete it, or rename it if you still rely on it`,
    ))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keryx init: an unmodified retired rule is removed with no Warnings printed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-retired-rules-"));
  try {
    const retiredEntry = retiredEntryForInitOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRootForInit, retiredEntry.fileName));
    await writeFile(path.join(rulesCore, retiredEntry.fileName), unmodifiedContent);

    const { logs, restore } = captureInitConsoleLog();
    try {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT_ARGS_KEEPING_GDSKILLS);
      });
    } finally {
      restore();
    }

    expect(existsSync(path.join(rulesCore, retiredEntry.fileName))).toBe(false);
    expect(logs.some((line) => line.includes("Warnings"))).toBe(false);
    expect(logs.some((line) => line.includes("is no longer shipped by keryx"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round-3 minor: the "Notices" print added beside "Warnings" was asserted at
// the `keryx update` call site only, so deleting this command's whole Notices
// block left every install/update/init test green. Same reason the Warnings
// print is covered here: `keryx init` prints through its own `heading`/`note`
// pair, which a regression in `update.ts` or `skills.ts` cannot reach.
test("keryx init: a removed stale runtime build prints under Notices, not Warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-stale-builds-"));
  try {
    // The shape an older install leaves behind: a per-runtime build sitting in
    // an installed skill directory that the current bundle no longer ships.
    const installedSkillDir = path.join(
      root, ".metaproject", "skills", "gdskills", "orchestration", "job-orchestrator",
    );
    await mkdir(installedSkillDir, { recursive: true });
    await writeFile(path.join(installedSkillDir, "SKILL.zed.md"), "# stale build\n", "utf8");

    const { logs, restore } = captureInitConsoleLog();
    try {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT_ARGS_KEEPING_GDSKILLS);
      });
    } finally {
      restore();
    }

    expect(existsSync(path.join(installedSkillDir, "SKILL.zed.md"))).toBe(false);
    const noticesAt = logs.findIndex((line) => line.includes("Notices"));
    expect(noticesAt).toBeGreaterThan(-1);
    expect(logs.findIndex((line) => line.includes("SKILL.zed.md was removed")))
      .toBeGreaterThan(noticesAt);
    expect(logs.some((line) => line.includes("Warnings"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes gdwiki as the canonical wiki manifest key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-"));

  try {
    await withCwd(root, async () => {
    await initCommand([
      "--yes",
      "--no-gdgraph",
      "--no-gdctx",
      "--no-gdskills",
      "--no-health",
      "--no-testing",
      "--no-memory",
      "--no-tasks",
    ]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };

    expect(manifest.modules.gdwiki?.enabled).toBe(true);
    expect(manifest.modules.wiki).toBeUndefined();
    // Flow 361: a fresh init writes the block to CLAUDE.local.md and creates no tracked AGENTS.md.
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("<!-- keryx:index -->");
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).not.toContain("Metaproject flow skill");
    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init ignores generated memory data but tracks canonical memory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-memory-policy-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await withCwd(root, async () => {
      await initCommand([
        "--yes",
        "--no-gdgraph",
        "--no-gdctx",
        "--no-gdwiki",
        "--no-gdskills",
        "--no-health",
        "--no-testing",
        "--no-tasks",
        "--no-security",
      ]);
    });
    await writeFile(path.join(root, ".metaproject", "memory", "decisions", "example.md"), "# Example\n", "utf8");
    const generatedPaths = [
      ".metaproject/data/memory/index/index.json",
      ".metaproject/data/memory/embeddings/vectors.jsonl",
      ".metaproject/data/memory/artifacts/legacy.md",
      ".metaproject/runtime/memory/search/run/report.json",
      ".metaproject/runtime/memory/tmp/staging",
    ];
    for (const candidate of generatedPaths) {
      const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "--quiet", "--", candidate], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(result.exitCode).toBe(0);
    }
    const canonical = Bun.spawnSync([
      "git",
      "check-ignore",
      "--no-index",
      "--quiet",
      "--",
      ".metaproject/memory/decisions/example.md",
    ], { cwd: root, stdout: "ignore", stderr: "ignore" });
    expect(canonical.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 315 T5 (R5-F1 major): `keryx init`'s writers used to follow in-repo
// symlinks that escape the project — a symlinked `.metaproject/metaproject.json`
// took a write meant for the manifest and landed it on whatever the link
// pointed at outside the project. Every write in init.ts now routes through
// `contained-write.ts`, which refuses (ContainedWriteError, reason
// "escaping-symlink") instead of following the link, so init throws and the
// outside file is left byte-for-byte unchanged.
test("keryx init refuses to write metaproject.json through a symlink that escapes the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-manifest-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-manifest-outside-"));
  try {
    const sentinelPath = path.join(outsideRoot, "victim.json");
    await writeFile(sentinelPath, "ORIGINAL\n", "utf8");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await symlink(sentinelPath, path.join(root, ".metaproject", "metaproject.json"));

    let caught: unknown;
    await withCwd(root, async () => {
      try {
        await initCommand(["--yes"]);
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(ContainedWriteError);
    expect((caught as ContainedWriteError).reason).toBe("escaping-symlink");
    expect(await readFile(sentinelPath, "utf8")).toBe("ORIGINAL\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}, 120_000);

// Flow 315 T5 (R5-F1 major): same failure mode, a DIRECTORY this time — a
// symlinked `.metaproject/reports` (a scaffold directory only
// `createBaseStructure` in this file creates; no other already-contained
// writer touches it, so this specifically proves THIS file's own `mkdir`
// calls are now routed through `mkdirContained` rather than being caught
// incidentally by some other module's containment) used to have its raw
// `mkdir(dir, { recursive: true })` follow the link and silently create real
// directory structure wherever it pointed, outside the project.
// `createBaseStructure`'s `mkdirContained` now refuses before anything is
// written into it.
test("keryx init refuses to create .metaproject/reports through a directory symlink that escapes the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-reports-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-reports-outside-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await symlink(outsideRoot, path.join(root, ".metaproject", "reports"));

    let caught: unknown;
    await withCwd(root, async () => {
      try {
        await initCommand(["--yes"]);
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(ContainedWriteError);
    expect((caught as ContainedWriteError).reason).toBe("escaping-symlink");
    expect(await readdir(outsideRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}, 120_000);

// Flow 315 T12 (R1-F1 major): `keryx init`'s OWN writers were fixed by flow
// 315 T5 (the two tests above), but `seedAssetsLock` — a helper `init` calls
// on the default `--yes` path — still used raw `mkdir`/`writeFile` against
// `<metaprojectRoot>/assets.lock.json`. A symlink there pointing outside the
// project used to be followed: the victim file (which does not parse as the
// lock's JSON shape) was treated as "malformed, reseed" and overwritten with
// the grammar-pins JSON, and `init` exited 0. `seedAssetsLock` now routes
// through `writeContained`, which refuses instead.
test("keryx init refuses to write assets.lock.json through a symlink that escapes the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-assets-lock-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-assets-lock-outside-"));
  try {
    const sentinelPath = path.join(outsideRoot, "victim.json");
    await writeFile(sentinelPath, "NOT THE LOCK SHAPE\n", "utf8");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await symlink(sentinelPath, path.join(root, ".metaproject", "assets.lock.json"));

    let caught: unknown;
    await withCwd(root, async () => {
      try {
        await initCommand(["--yes"]);
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(ContainedWriteError);
    expect((caught as ContainedWriteError).reason).toBe("escaping-symlink");
    expect(await readFile(sentinelPath, "utf8")).toBe("NOT THE LOCK SHAPE\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}, 120_000);

// Flow 315 T12 (R1-F1 major): same failure mode, in `installGdskills` (called
// by `init` on the default `--yes` path). `skills/catalog.md` used to be a
// raw `writeFile`; a symlink there pointing outside the project was followed
// and the outside file silently became the rendered gdskills catalog.
// `installGdskills` now routes the catalog (and manifest) write through
// `writeContained`, which refuses before anything downstream of it runs.
test("keryx init refuses to write skills/catalog.md through a symlink that escapes the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-catalog-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-catalog-outside-"));
  try {
    const sentinelPath = path.join(outsideRoot, "victim.md");
    await writeFile(sentinelPath, "ORIGINAL\n", "utf8");
    await mkdir(path.join(root, ".metaproject", "skills"), { recursive: true });
    await symlink(sentinelPath, path.join(root, ".metaproject", "skills", "catalog.md"));

    let caught: unknown;
    await withCwd(root, async () => {
      try {
        await initCommand(["--yes"]);
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(ContainedWriteError);
    expect((caught as ContainedWriteError).reason).toBe("escaping-symlink");
    expect(await readFile(sentinelPath, "utf8")).toBe("ORIGINAL\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}, 120_000);

// Flow 315 T12 (R1-F1 major, resolves R1-F8): the `reports` test just above
// symlinks a directory NOTHING actually writes a file into during a default
// `--yes` init — pre-fix, `mkdir(dir, { recursive: true })` on a link to an
// EXISTING directory is a no-op, so the test still "fails" pre-fix (nothing
// throws, so `caught` stays `undefined`), but only through that incidental
// assertion, never by observing a real escape. This test instead symlinks
// `.metaproject/core/gdskills` — a directory `installGdskills`
// (default-enabled) actually writes FILES into (`core/gdskills/contracts/*`,
// via `installContracts`) — so pre-fix this proves the real R1-F1 escape
// (the contract files land in the linked-to directory, outside the project,
// and `init` exits 0), not just an inert mkdir no-op. The symlink sits at
// `core/gdskills` specifically, not the whole `core` directory: `core/gdgraph`
// is written first (by gdgraph, already contained since flow 315 T5) and
// must succeed normally so this test isolates the gdskills-specific fix
// rather than incidentally re-proving T5's. (`.metaproject/rules` is NOT
// tested the same way: it was already contained pre-fix, independently of
// this flow's `contained-write` retrofit — `syncAgentRules`, which owns that
// directory, already refused an escaping `rules` link before flow 315 T5
// touched anything, and `installBundledRules`'s OWN `rules/core` copy below
// gdskills' install is covered by the read-only-directory and
// symlinked-contracts-directory tests in `install.test.ts`.)
test("keryx init refuses to write core/gdskills/contracts/* through a directory symlink that escapes the project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-core-gdskills-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "keryx-init-escape-core-gdskills-outside-"));
  try {
    await mkdir(path.join(root, ".metaproject", "core"), { recursive: true });
    await symlink(outsideRoot, path.join(root, ".metaproject", "core", "gdskills"));

    let caught: unknown;
    await withCwd(root, async () => {
      try {
        await initCommand(["--yes"]);
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(ContainedWriteError);
    expect((caught as ContainedWriteError).reason).toBe("escaping-symlink");
    expect(await readdir(outsideRoot)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}, 120_000);

test("memory index output is ignored and reproducible after init", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-memory-index-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await withCwd(root, async () => {
      await initCommand([
        "--yes",
        "--no-gdgraph",
        "--no-gdctx",
        "--no-gdwiki",
        "--no-gdskills",
        "--no-health",
        "--no-testing",
        "--no-tasks",
        "--no-security",
      ]);
      await memoryCommand(["index"]);
      const indexPath = path.join(root, ".metaproject", "data", "memory", "index", "index.json");
      const first = await readFile(indexPath, "utf8");
      await memoryCommand(["index"]);
      const second = await readFile(indexPath, "utf8");
      expect(JSON.parse(second).entries).toEqual(JSON.parse(first).entries);
      const ignored = Bun.spawnSync([
        "git",
        "check-ignore",
        "--no-index",
        "--quiet",
        "--",
        ".metaproject/data/memory/index/index.json",
      ], { cwd: root, stdout: "ignore", stderr: "ignore" });
      expect(ignored.exitCode).toBe(0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-F2 regression coverage: `keryx init`/`keryx update` used to ABORT
// outright when a `.git/hooks` file resolved outside the git common dir
// through a symlink — even for a legitimate, common setup (a hook symlinked
// to an in-project, repo-tracked script) or a dangling link. Both now leave
// `initCommand` completing normally: the first because it's an accepted
// target (inside the project root), the second because the refusal is a
// warning, not an uncaught throw.
const GDGRAPH_ONLY_INIT_ARGS = [
  "--yes",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security",
];

test("keryx init succeeds, and writes the hook block, when .git/hooks/post-commit links to an in-project tracked script", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-hook-inproject-link-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    const scriptDir = path.join(root, "scripts");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "post-commit");
    await writeFile(scriptPath, "#!/usr/bin/env sh\necho tracked\n", "utf8");
    await symlink(path.join("..", "..", "scripts", "post-commit"), path.join(root, ".git", "hooks", "post-commit"));

    const { logs, restore } = captureInitConsoleLog();
    try {
      await withCwd(root, async () => {
        await initCommand(GDGRAPH_ONLY_INIT_ARGS);
      });
    } finally {
      restore();
    }

    expect(logs.some((line) => line.includes("resolves outside") || line.includes("Escape"))).toBe(false);
    const written = await readFile(scriptPath, "utf8");
    expect(written).toContain("# keryx:gdgraph-post-commit:begin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keryx init warns and completes when .git/hooks/post-commit is a dangling symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-hook-dangling-link-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await symlink(path.join(root, "does-not-exist"), path.join(root, ".git", "hooks", "post-commit"));

    const { logs, restore } = captureInitConsoleLog();
    let threw = false;
    try {
      await withCwd(root, async () => {
        await initCommand(GDGRAPH_ONLY_INIT_ARGS);
      });
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    expect(logs.some((line) => line.includes("Warnings"))).toBe(true);
    expect(logs.some((line) => line.includes("dangling symlink"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361: a fresh init records every entrypoint target as local and writes
// the managed block there — never into a tracked AGENTS.md / CLAUDE.md.
const ENTRYPOINT_INIT_ARGS = [...MINIMAL_INIT_ARGS_KEEPING_GDSKILLS, "--no-gdskills"];

function gitInEntrypointRepo(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

test("flow 361: init then update keep the block in CLAUDE.local.md and out of tracked AGENTS.md and CLAUDE.md", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-entrypoints-"));
  const agents = "# Team\n\nUse local conventions.\n";
  const claude = "# Claude\n\nPrefer compact context.\n";
  try {
    gitInEntrypointRepo(root, ["init", "-q"]);
    gitInEntrypointRepo(root, ["config", "user.email", "test@test.com"]);
    gitInEntrypointRepo(root, ["config", "user.name", "test"]);
    await writeFile(path.join(root, "AGENTS.md"), agents, "utf8");
    await writeFile(path.join(root, "CLAUDE.md"), claude, "utf8");
    gitInEntrypointRepo(root, ["add", "--", "AGENTS.md", "CLAUDE.md"]);
    gitInEntrypointRepo(root, ["commit", "-q", "-m", "fixture"]);

    const assertLocalOnly = async () => {
      expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("<!-- keryx:index -->");
      expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(agents);
      expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(claude);
      const status = gitInEntrypointRepo(root, ["status", "--porcelain"]);
      expect(status).not.toMatch(/ AGENTS\.md$/m);
      expect(status).not.toMatch(/ CLAUDE\.md$/m);
      const override = await readFile(path.join(root, "AGENTS.override.md"), "utf8");
      expect(override).toContain("<!-- keryx:index -->");
      expect(override.endsWith(agents)).toBe(true);
    };

    await withCwd(root, async () => {
      await initCommand(ENTRYPOINT_INIT_ARGS);
    });
    await assertLocalOnly();
    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      agentEntrypoints: Record<string, unknown>;
    };
    expect(manifest.agentEntrypoints).toEqual({
      index: ".metaproject/index.md",
      readme: ".metaproject/README.md",
      ...defaultEntrypointTargets(),
    });
    // The team files are still what gets imported as tracked rules; a local target never is.
    const ruleFiles = await readdir(path.join(root, ".metaproject", "rules"));
    expect(ruleFiles).toContain("agents-md.md");
    expect(ruleFiles).toContain("claude-md.md");
    expect(ruleFiles).not.toContain("claude-local-md.md");
    expect(ruleFiles).not.toContain("agents-override-md.md");

    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
    await assertLocalOnly();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: init in a repository with no entrypoints creates no tracked AGENTS.md or CLAUDE.md and says Codex was skipped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-entrypoints-empty-"));
  try {
    gitInEntrypointRepo(root, ["init", "-q"]);
    const { logs, restore } = captureInitConsoleLog();
    try {
      await withCwd(root, async () => {
        await initCommand(ENTRYPOINT_INIT_ARGS);
      });
    } finally {
      restore();
    }

    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("<!-- keryx:index -->");
    expect(logs.some((line) => line.includes("Codex: skipped"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: a second init reads the legacy string-array manifest instead of choking on it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-entrypoints-legacy-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Team\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: {}, agentEntrypoints: { index: ".metaproject/index.md", readme: ".metaproject/README.md", root: ["AGENTS.md"] } }),
      "utf8",
    );
    await withCwd(root, async () => {
      await initCommand(ENTRYPOINT_INIT_ARGS);
    });
    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      agentEntrypoints: { root: unknown[] };
    };
    expect(manifest.agentEntrypoints.root).toEqual([
      { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" },
      { runtime: "claude", path: "CLAUDE.local.md", scope: "local" },
    ]);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Team\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

// Flow 361 T7: init and update never write the tracked `.gitignore`. The
// managed ignore block goes to `<git-common-dir>/info/exclude`, and the
// per-developer files keryx writes are ignored there too.
describe("flow 361: ignore rules go to info/exclude", () => {
  const LOCAL_TARGETS = ["CLAUDE.local.md", "AGENTS.override.md", ".claude/settings.local.json"];

  /**
   * `core.excludesFile` points at a file that does not exist, so the
   * developer's own global excludes (Claude Code adds
   * `.claude/settings.local.json` there) cannot answer for the fixture.
   */
  async function committedRepo(prefix: string, files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    gitInEntrypointRepo(root, ["init", "-q"]);
    gitInEntrypointRepo(root, ["config", "user.email", "test@test.com"]);
    gitInEntrypointRepo(root, ["config", "user.name", "test"]);
    gitInEntrypointRepo(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
    for (const [rel, content] of Object.entries(files)) {
      await writeFile(path.join(root, rel), content, "utf8");
    }
    gitInEntrypointRepo(root, ["add", "--", ...Object.keys(files)]);
    gitInEntrypointRepo(root, ["commit", "-q", "-m", "fixture"]);
    return root;
  }

  function checkIgnore(root: string, target: string): number | null {
    return Bun.spawnSync(["git", "check-ignore", "-q", "--", target], { cwd: root, stdout: "ignore", stderr: "ignore" }).exitCode;
  }

  async function readExclude(root: string): Promise<string> {
    return readFile(path.join(root, ".git", "info", "exclude"), "utf8").catch(() => "");
  }

  test("init then update leave .gitignore out of git status and all three local targets ignored (AC2, AC6, AC7)", async () => {
    const root = await committedRepo("keryx-init-ignore-", { "AGENTS.md": "# Team\n", "CLAUDE.md": "# Claude\n" });
    try {
      const assertIgnoredLocally = async () => {
        expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
        const status = gitInEntrypointRepo(root, ["status", "--porcelain"]);
        expect(status).not.toContain(".gitignore");
        for (const target of LOCAL_TARGETS) {
          expect(checkIgnore(root, target)).toBe(0);
          expect(status).not.toContain(target);
        }
        const exclude = await readExclude(root);
        expect(exclude).toContain("# keryx:begin\n");
        expect(exclude).toContain("\n.metaproject/runtime/\n");
        expect(checkIgnore(root, ".metaproject/runtime/x")).toBe(0);
      };

      await withCwd(root, async () => {
        await initCommand(ENTRYPOINT_INIT_ARGS);
      });
      await assertIgnoredLocally();
      const afterInit = await readExclude(root);

      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks"]);
      });
      await assertIgnoredLocally();
      expect(await readExclude(root)).toBe(afterInit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("init writes no ignore block anywhere when .metaproject/ is ignored as a whole (AC6)", async () => {
    const gitignore = `.metaproject/\n${LOCAL_TARGETS.join("\n")}\n`;
    const root = await committedRepo("keryx-init-ignore-whole-", { ".gitignore": gitignore });
    try {
      const excludeBefore = await readExclude(root);
      await withCwd(root, async () => {
        await initCommand(ENTRYPOINT_INIT_ARGS);
      });

      expect(await readExclude(root)).toBe(excludeBefore);
      expect(excludeBefore).not.toContain("# keryx:begin");
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(gitignore);
      // `.keryx/sandbox-policy.json` is a project file init creates; nothing else shows up.
      expect(gitInEntrypointRepo(root, ["status", "--porcelain"])).toBe("?? .keryx/\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("init --preview writes no ignore rule", async () => {
    const root = await committedRepo("keryx-init-ignore-preview-", { "AGENTS.md": "# Team\n" });
    try {
      const excludeBefore = await readExclude(root);
      const { restore } = captureInitConsoleLog();
      try {
        await withCwd(root, async () => {
          await initCommand([...ENTRYPOINT_INIT_ARGS, "--preview"]);
        });
      } finally {
        restore();
      }

      expect(await readExclude(root)).toBe(excludeBefore);
      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(gitInEntrypointRepo(root, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("outside a git repository init writes no .gitignore and prints one note", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-init-ignore-nogit-"));
    try {
      const { logs, restore } = captureInitConsoleLog();
      try {
        await withCwd(root, async () => {
          await initCommand(ENTRYPOINT_INIT_ARGS);
        });
      } finally {
        restore();
      }

      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(logs.filter((line) => line.includes("Ignore rules: skipped") && line.includes("not a git repository"))).toHaveLength(1);
      expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("<!-- keryx:index -->");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
