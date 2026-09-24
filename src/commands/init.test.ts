import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { RETIRED_RULES } from "../gdskills/retired-rules";
import { ContainedWriteError } from "../lib/contained-write";
import { memoryCommand } from "./memory";
import { initCommand } from "./init";

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
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).not.toContain("Metaproject flow skill");
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
