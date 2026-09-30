// Flow 361 T12: a runtime switched from `scope: "local"` back to `"shared"`
// (or Codex to mode `skip`) must not keep what keryx wrote into its local
// target — the block would be read twice (`CLAUDE.local.md`), or a stale copy
// of the team file would keep hiding the real one from Codex
// (`AGENTS.override.md`). Every fixture is a real temp git repository; the
// block is written by the real writers, local first, then switched.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { uniqueTestRoot } from "../lib/test-tmp";
import { syncAgentRules } from "./agent-entrypoints";
import { previewEntrypointLines } from "./entrypoint-inspection";
import {
  defaultEntrypointTargets,
  localClaudeSettingsTarget,
  localRootEntry,
  sharedRootEntry,
  type EntrypointTargets,
  type RootEntrypointEntry,
} from "./entrypoint-targets";

const BLOCK_START = "<!-- keryx:index -->";
const AGENTS = "# Team\n\nUse the team rules.\n";

const CLAUDE_SHARED: EntrypointTargets = {
  root: [sharedRootEntry("claude"), localRootEntry("codex")],
  claudeSettings: localClaudeSettingsTarget(),
};
const CODEX_SHARED: EntrypointTargets = {
  root: [localRootEntry("claude"), sharedRootEntry("codex")],
  claudeSettings: localClaudeSettingsTarget(),
};
const CODEX_SKIP: EntrypointTargets = {
  root: [localRootEntry("claude"), { ...(localRootEntry("codex") as Extract<RootEntrypointEntry, { mode: string }>), mode: "skip" }],
  claudeSettings: localClaudeSettingsTarget(),
};

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** A committed repository holding `AGENTS.md` (and `extra`), with no global excludes answering for it. */
async function repo(prefix: string, extra: Record<string, string> = {}): Promise<string> {
  const root = uniqueTestRoot(tmpdir(), prefix);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "keryx@example.test"]);
  git(root, ["config", "user.name", "Keryx Test"]);
  git(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
  for (const [rel, content] of Object.entries({ "AGENTS.md": AGENTS, ...extra })) await writeFile(path.join(root, rel), content);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

async function sync(root: string, targets: EntrypointTargets): Promise<string[]> {
  const notices: string[] = [];
  await syncAgentRules(root, path.join(root, ".metaproject"), { targets, onNotice: (line) => notices.push(line) });
  return notices;
}

async function read(root: string, rel: string): Promise<string> {
  return readFile(path.join(root, rel), "utf8");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every file under `root` but `.git`, as path → sha256. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (rel.startsWith(".git/")) continue;
    result[rel] = createHash("sha256").update(await readFile(path.join(root, rel))).digest("hex");
  }
  return result;
}

async function withRepo(prefix: string, body: (root: string) => Promise<void>, extra: Record<string, string> = {}): Promise<void> {
  const root = await repo(prefix, extra);
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The manifest's `agentEntrypoints` for `targets`, as a hand edit leaves it. */
function manifestFor(targets: EntrypointTargets): unknown {
  return { root: targets.root, claudeSettings: targets.claudeSettings };
}

describe("flow 361 T12: switching a runtime back to shared cleans its local target", () => {
  test("Claude local → shared: a keryx-only CLAUDE.local.md is removed and the block is in CLAUDE.md once", async () => {
    await withRepo("keryx-leftover-claude-only", async (root) => {
      await sync(root, defaultEntrypointTargets());
      const created = await read(root, "CLAUDE.local.md");
      expect(created).toContain(BLOCK_START);
      // keryx created it in an AGENTS-only repository, so it carries the import too.
      expect(created.split("\n")).toContain("@AGENTS.md");

      const notices = await sync(root, CLAUDE_SHARED);

      expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
      expect(count(await read(root, "CLAUDE.md"), BLOCK_START)).toBe(1);
      expect(notices.some((line) => line.startsWith("CLAUDE.local.md:") && line.includes("removed the file"))).toBe(true);
    });
  });

  test("Claude local → shared: developer content in CLAUDE.local.md is kept byte for byte, only keryx's part goes, and the file is named", async () => {
    const mine = "# My notes\n\nMy sandbox URL is http://localhost:4000.\n\n## Habits\n\nRun the fast suite first.\n";
    await withRepo("keryx-leftover-claude-mine", async (root) => {
      await writeFile(path.join(root, "CLAUDE.local.md"), mine);
      await sync(root, defaultEntrypointTargets());
      expect(await read(root, "CLAUDE.local.md")).toContain(BLOCK_START);

      const notices = await sync(root, CLAUDE_SHARED);

      expect(await read(root, "CLAUDE.local.md")).toBe(mine);
      expect(count(await read(root, "CLAUDE.md"), BLOCK_START)).toBe(1);
      expect(notices.some((line) => line.startsWith("CLAUDE.local.md:") && line.includes("kept"))).toBe(true);
    });
  });

  test("Claude local → shared: a line the developer added to a keryx-created file keeps the file; keryx's import goes with the block", async () => {
    await withRepo("keryx-leftover-claude-appended", async (root) => {
      await sync(root, defaultEntrypointTargets());
      await writeFile(path.join(root, "CLAUDE.local.md"), `${await read(root, "CLAUDE.local.md")}\nMy own line.\n`);

      await sync(root, CLAUDE_SHARED);

      const kept = await read(root, "CLAUDE.local.md");
      expect(kept).not.toContain(BLOCK_START);
      expect(kept).not.toContain("<!-- keryx:");
      expect(kept.split("\n")).not.toContain("@AGENTS.md");
      expect(kept).toContain("My own line.\n");
    });
  });

  test("Codex local → shared: the keryx-generated AGENTS.override.md is removed and the block is in AGENTS.md", async () => {
    await withRepo("keryx-leftover-codex-shared", async (root) => {
      await sync(root, defaultEntrypointTargets());
      expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(true);

      const notices = await sync(root, CODEX_SHARED);

      expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
      expect(count(await read(root, "AGENTS.md"), BLOCK_START)).toBe(1);
      expect(notices.some((line) => line.startsWith("AGENTS.override.md:") && line.includes("removed"))).toBe(true);
    });
  });

  test("Codex mode skip: a keryx-generated AGENTS.override.md is removed and AGENTS.md is left alone", async () => {
    await withRepo("keryx-leftover-codex-skip", async (root) => {
      await sync(root, defaultEntrypointTargets());
      expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(true);

      await sync(root, CODEX_SKIP);

      expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
      expect(await read(root, "AGENTS.md")).toBe(AGENTS);
    });
  });

  test("an AGENTS.override.md without keryx provenance is the developer's: left alone and reported, under shared and under skip", async () => {
    for (const targets of [CODEX_SHARED, CODEX_SKIP]) {
      await withRepo("keryx-leftover-codex-unmanaged", async (root) => {
        await writeFile(path.join(root, "AGENTS.override.md"), "# My own override\n");

        const notices = await sync(root, targets);

        expect(await read(root, "AGENTS.override.md")).toBe("# My own override\n");
        expect(notices.some((line) => line.startsWith("AGENTS.override.md:") && line.includes("not generated by keryx"))).toBe(true);
      });
    }
  });

  test("a keryx-generated override that is tracked in git is left for the team, not deleted", async () => {
    await withRepo("keryx-leftover-codex-tracked", async (root) => {
      await sync(root, defaultEntrypointTargets());
      git(root, ["add", "-f", "AGENTS.override.md"]);
      git(root, ["commit", "-q", "-m", "override"]);

      const notices = await sync(root, CODEX_SHARED);

      expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(true);
      expect(notices.some((line) => line.startsWith("AGENTS.override.md:") && line.includes("tracked"))).toBe(true);
    });
  });

  test("preview names what would be removed and removes nothing", async () => {
    await withRepo("keryx-leftover-preview", async (root) => {
      await sync(root, defaultEntrypointTargets());
      const before = await snapshot(root);

      const lines = await previewEntrypointLines(root, manifestFor({ root: [sharedRootEntry("claude"), sharedRootEntry("codex")], claudeSettings: localClaudeSettingsTarget() }));

      expect(lines.some((line) => line.includes("CLAUDE.local.md: would be removed"))).toBe(true);
      expect(lines.some((line) => line.includes("AGENTS.override.md: would be removed"))).toBe(true);
      expect(await snapshot(root)).toEqual(before);
    });
  });

  test("preview says only keryx's part of a CLAUDE.local.md with developer content would go", async () => {
    await withRepo("keryx-leftover-preview-mine", async (root) => {
      await writeFile(path.join(root, "CLAUDE.local.md"), "# My notes\n\nMine.\n");
      await sync(root, defaultEntrypointTargets());
      const lines = await previewEntrypointLines(root, manifestFor(CLAUDE_SHARED));
      expect(lines.some((line) => line.includes("CLAUDE.local.md: the managed keryx block would be taken out") && line.includes("kept"))).toBe(true);
    });
  });

  test("a second run after the switch changes nothing", async () => {
    const shared: EntrypointTargets = { root: [sharedRootEntry("claude"), sharedRootEntry("codex")], claudeSettings: localClaudeSettingsTarget() };
    await withRepo("keryx-leftover-second-run", async (root) => {
      await writeFile(path.join(root, "CLAUDE.local.md"), "# My notes\n\nMine.\n");
      await sync(root, defaultEntrypointTargets());
      await sync(root, shared);
      const first = await snapshot(root);

      const notices = await sync(root, shared);

      expect(await snapshot(root)).toEqual(first);
      expect(notices.some((line) => line.startsWith("CLAUDE.local.md:") || line.startsWith("AGENTS.override.md:"))).toBe(false);
    });
  });
});
