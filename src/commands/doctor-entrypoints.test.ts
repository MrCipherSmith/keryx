// Flow 361 T9, AC11 — `keryx doctor`'s `entrypoints` check. Every finding is
// a `warn` with `keryx update` (or a named manual step) as its fix, never a
// `fail`; content the team committed in `HEAD` is the owner-approved shared
// case and is never warned about; and the check writes nothing.
//
// Every fixture is a real temp git repository whose `core.excludesFile`
// points at a file that does not exist, so the developer's own global
// excludes (Claude Code adds `.claude/settings.local.json` there) cannot
// answer for it.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { syncAgentRules } from "../rules/agent-entrypoints";
import { CODEX_PROJECT_DOC_MAX_BYTES, renderCodexOverride, resolveProjectEntrypoints } from "../rules/entrypoint-writers";
import { buildDoctorReport, checkEntrypoints, type DoctorCheck } from "./doctor";

const BLOCK = "<!-- keryx:index -->\nRead .metaproject/index.md first.\n<!-- /keryx:index -->\n";
const AGENTS = "# Team\n\nUse the team rules.\n";
const LOCAL_CLAUDE = { runtime: "claude", path: "CLAUDE.local.md", scope: "local" };
const LOCAL_CODEX = { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" };
const SHARED_CLAUDE = { runtime: "claude", path: "CLAUDE.md", scope: "shared" };
const SHARED_CODEX = { runtime: "codex", path: "AGENTS.md", scope: "shared" };
const LOCAL_SETTINGS = { path: ".claude/settings.local.json", scope: "local" };
const SHARED_SETTINGS = { path: ".claude/settings.json", scope: "shared" };
const MANAGED_HOOKS = `${JSON.stringify(
  { hooks: { PreToolUse: [{ _keryxManaged: "security-agent-hooks", matcher: "*", hooks: [{ type: "command", command: "keryx security check-output --runtime claude" }] }] } },
  null,
  2,
)}\n`;
const LEGACY_IGNORE_BLOCK = "# keryx:begin\n.metaproject/runtime/\n# keryx:end\n";
/** Every local target keryx writes, as the managed block in `info/exclude` would list them. */
const LOCAL_TARGETS = ["CLAUDE.local.md", "AGENTS.override.md", ".claude/settings.local.json"];

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

type Fixture = {
  /** Committed in the first commit. */
  committed?: Record<string, string>;
  agentEntrypoints: unknown;
  security?: boolean;
  /** Lines for `info/exclude`, as `keryx update` would have written them. */
  exclude?: readonly string[];
};

/** A committed repository holding a manifest with `agentEntrypoints` plus `committed`. */
async function repo(prefix: string, fixture: Fixture): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@test.com"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
  const modules = fixture.security === true ? { security: { enabled: true, hooks: { agent: ".claude/settings.local.json" } } } : {};
  await writeRel(root, ".metaproject/metaproject.json", `${JSON.stringify({ modules, agentEntrypoints: fixture.agentEntrypoints }, null, 2)}\n`);
  for (const [rel, content] of Object.entries(fixture.committed ?? {})) await writeRel(root, rel, content);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  if (fixture.exclude !== undefined) {
    await writeRel(root, ".git/info/exclude", `# keryx:begin\n${fixture.exclude.join("\n")}\n# keryx:end\n`);
  }
  return root;
}

async function writeRel(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content, "utf8");
}

/** Every file under `root` (`.git` included), as path → sha256, to prove the check wrote nothing. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, absolute);
    // git itself refreshes the index stat cache on `git diff`/`status`.
    if (rel === path.join(".git", "index")) continue;
    result[rel] = createHash("sha256").update(await readFile(absolute)).digest("hex");
  }
  return result;
}

async function withRepo(prefix: string, fixture: Fixture, body: (root: string) => Promise<void>): Promise<void> {
  const root = await repo(prefix, fixture);
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectWarn(check: DoctorCheck, ...fragments: string[]): void {
  expect(check.id).toBe("entrypoints");
  expect(check.status).toBe("warn");
  for (const fragment of fragments) expect(check.detail).toContain(fragment);
  expect(check.fix).toContain("keryx update");
}

/** A fully migrated, local-scope repository: nothing for doctor to say. */
const MIGRATED: Fixture = {
  committed: { "AGENTS.md": AGENTS },
  agentEntrypoints: { root: [LOCAL_CLAUDE, LOCAL_CODEX], claudeSettings: LOCAL_SETTINGS },
  exclude: LOCAL_TARGETS,
};

async function writeFreshLocalTargets(root: string, agents: string = AGENTS): Promise<void> {
  await writeRel(root, "CLAUDE.local.md", `# Local Claude Instructions\n\n${BLOCK}`);
  await writeRel(root, "AGENTS.override.md", renderCodexOverride({ source: "AGENTS.md", sourceContent: agents, block: BLOCK }));
}

describe("keryx doctor: entrypoints (flow 361, AC11)", () => {
  test("a migrated repository with its local targets in place is ok", async () => {
    await withRepo("keryx-doctor-entry-ok-", MIGRATED, async (root) => {
      await writeFreshLocalTargets(root);
      const check = await checkEntrypoints(root);
      expect(check).toMatchObject({ id: "entrypoints", status: "ok" });
      expect(check.fix).toBeUndefined();
    });
  });

  test("a managed block in a tracked AGENTS.md whose scope is local warns, with keryx update as the fix", async () => {
    await withRepo("keryx-doctor-entry-block-", MIGRATED, async (root) => {
      await writeFreshLocalTargets(root);
      await writeRel(root, "AGENTS.md", `${AGENTS}\n${BLOCK}`);
      expectWarn(await checkEntrypoints(root), "AGENTS.md", "keryx:index");
    });
  });

  test("a managed block in a tracked CLAUDE.md whose scope is local warns", async () => {
    await withRepo("keryx-doctor-entry-claude-", { ...MIGRATED, committed: { "AGENTS.md": AGENTS, "CLAUDE.md": "# Claude\n" } }, async (root) => {
      await writeFreshLocalTargets(root);
      await writeRel(root, "CLAUDE.md", `# Claude\n\n${BLOCK}`);
      expectWarn(await checkEntrypoints(root), "CLAUDE.md");
    });
  });

  test("a block committed in HEAD is the team's shared choice: no warning, the scope is named", async () => {
    const fixture: Fixture = {
      committed: { "AGENTS.md": `${AGENTS}\n${BLOCK}`, "CLAUDE.md": `# Claude\n\n${BLOCK}` },
      agentEntrypoints: { root: ["AGENTS.md", "CLAUDE.md"] },
    };
    await withRepo("keryx-doctor-entry-head-", fixture, async (root) => {
      const check = await checkEntrypoints(root);
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("AGENTS.md");
      expect(check.detail).toContain("shared");
    });
  });

  test("a managed ignore block in a tracked .gitignore warns; one committed in HEAD does not", async () => {
    await withRepo("keryx-doctor-entry-gitignore-", { ...MIGRATED, committed: { "AGENTS.md": AGENTS, ".gitignore": "node_modules/\n" } }, async (root) => {
      await writeFreshLocalTargets(root);
      await writeRel(root, ".gitignore", `node_modules/\n\n${LEGACY_IGNORE_BLOCK}`);
      expectWarn(await checkEntrypoints(root), ".gitignore", "info/exclude");
    });
    await withRepo(
      "keryx-doctor-entry-gitignore-head-",
      { ...MIGRATED, committed: { "AGENTS.md": AGENTS, ".gitignore": `node_modules/\n\n${LEGACY_IGNORE_BLOCK}` } },
      async (root) => {
        await writeFreshLocalTargets(root);
        expect((await checkEntrypoints(root)).status).toBe("ok");
      },
    );
  });

  test("keryx-managed hooks in a tracked .claude/settings.json whose scope is local warn; committed ones do not", async () => {
    const committed = { "AGENTS.md": AGENTS, ".claude/settings.json": '{ "model": "sonnet" }\n' };
    await withRepo("keryx-doctor-entry-hooks-", { ...MIGRATED, committed }, async (root) => {
      await writeFreshLocalTargets(root);
      await writeRel(root, ".claude/settings.json", MANAGED_HOOKS);
      expectWarn(await checkEntrypoints(root), ".claude/settings.json", "hooks");
    });
    await withRepo("keryx-doctor-entry-hooks-head-", { ...MIGRATED, committed: { ...committed, ".claude/settings.json": MANAGED_HOOKS } }, async (root) => {
      await writeFreshLocalTargets(root);
      const check = await checkEntrypoints(root);
      expect(check.status).toBe("ok");
      expect(check.detail).toContain(".claude/settings.json");
    });
  });

  test("managed hooks in both Claude settings files warn: Claude Code would run them twice", async () => {
    const fixture: Fixture = { ...MIGRATED, agentEntrypoints: { root: [LOCAL_CLAUDE, LOCAL_CODEX], claudeSettings: SHARED_SETTINGS }, committed: { "AGENTS.md": AGENTS, ".claude/settings.json": MANAGED_HOOKS } };
    await withRepo("keryx-doctor-entry-hooks-twice-", fixture, async (root) => {
      await writeFreshLocalTargets(root);
      await writeRel(root, ".claude/settings.local.json", MANAGED_HOOKS);
      expectWarn(await checkEntrypoints(root), "twice");
    });
  });

  test("a stale AGENTS.override.md warns with keryx update", async () => {
    await withRepo("keryx-doctor-entry-stale-", MIGRATED, async (root) => {
      await writeFreshLocalTargets(root);
      // The team file moved on after the override was generated.
      await writeRel(root, "AGENTS.md", `${AGENTS}\nA newer team rule.\n`);
      git(root, ["commit", "-q", "-am", "team edit"]);
      expectWarn(await checkEntrypoints(root), "AGENTS.override.md", "stale");
    });
  });

  test("an AGENTS.override.md larger than Codex reads warns that Codex truncates it", async () => {
    const big = `${AGENTS}\n${"x".repeat(CODEX_PROJECT_DOC_MAX_BYTES)}\n`;
    await withRepo("keryx-doctor-entry-size-", { ...MIGRATED, committed: { "AGENTS.md": big } }, async (root) => {
      await writeFreshLocalTargets(root, big);
      const check = await checkEntrypoints(root);
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("AGENTS.override.md");
      expect(check.detail).toContain(String(CODEX_PROJECT_DOC_MAX_BYTES));
      expect(check.detail).toContain("truncat");
      expect(check.fix?.length ?? 0).toBeGreaterThan(0);
    });
  });

  test("a local target missing in this checkout warns with keryx update", async () => {
    await withRepo("keryx-doctor-entry-missing-", MIGRATED, async (root) => {
      expectWarn(await checkEntrypoints(root), "CLAUDE.local.md", "AGENTS.override.md", "missing");
    });
  });

  test("the security hook file counts as missing only when hooks are expected", async () => {
    await withRepo("keryx-doctor-entry-settings-", { ...MIGRATED, security: true }, async (root) => {
      await writeFreshLocalTargets(root);
      expectWarn(await checkEntrypoints(root), ".claude/settings.local.json", "missing");
    });
    await withRepo("keryx-doctor-entry-settings-none-", MIGRATED, async (root) => {
      await writeFreshLocalTargets(root);
      expect((await checkEntrypoints(root)).status).toBe("ok");
    });
  });

  test("from a linked worktree, local targets the main checkout has are reported missing", async () => {
    await withRepo("keryx-doctor-entry-worktree-", MIGRATED, async (main) => {
      await writeFreshLocalTargets(main);
      const linked = `${main}-linked`;
      try {
        git(main, ["worktree", "add", "-q", linked, "-b", "linked-branch"]);
        expect((await checkEntrypoints(main)).status).toBe("ok");
        expectWarn(await checkEntrypoints(linked), "CLAUDE.local.md", "missing");
      } finally {
        await rm(linked, { recursive: true, force: true });
      }
    });
  });

  test("a local target git does not ignore warns with keryx update", async () => {
    await withRepo("keryx-doctor-entry-unignored-", { ...MIGRATED, exclude: ["AGENTS.override.md"] }, async (root) => {
      await writeFreshLocalTargets(root);
      expectWarn(await checkEntrypoints(root), "CLAUDE.local.md", "not ignored");
    });
  });

  test("shared targets are not expected to exist locally or be ignored", async () => {
    const fixture: Fixture = {
      committed: { "AGENTS.md": `${AGENTS}\n${BLOCK}`, "CLAUDE.md": `# Claude\n\n${BLOCK}` },
      agentEntrypoints: { root: [SHARED_CLAUDE, SHARED_CODEX], claudeSettings: SHARED_SETTINGS },
    };
    await withRepo("keryx-doctor-entry-shared-", fixture, async (root) => {
      expect((await checkEntrypoints(root)).status).toBe("ok");
    });
  });

  test("a shared-scope runtime whose local target still holds keryx content warns before keryx update runs, and not after", async () => {
    const shared = { root: [SHARED_CLAUDE, SHARED_CODEX], claudeSettings: LOCAL_SETTINGS };
    await withRepo("keryx-doctor-entry-leftover-", { committed: { "AGENTS.md": AGENTS }, agentEntrypoints: shared, exclude: LOCAL_TARGETS }, async (root) => {
      // What the local-scope run left behind, before the entries were switched to shared by hand.
      await writeFreshLocalTargets(root);

      expectWarn(await checkEntrypoints(root), "CLAUDE.local.md", "AGENTS.override.md", "shared");

      const resolved = await resolveProjectEntrypoints(root, shared);
      await syncAgentRules(root, path.join(root, ".metaproject"), { targets: resolved.targets });
      const after = await checkEntrypoints(root);
      expect(after.status).toBe("ok");
      expect(after.detail).not.toContain("CLAUDE.local.md");
      expect(after.detail).not.toContain("AGENTS.override.md");
    });
  });

  test("an override keryx did not generate is not warned about under shared scope", async () => {
    const shared = { root: [SHARED_CLAUDE, SHARED_CODEX], claudeSettings: LOCAL_SETTINGS };
    const committed = { "AGENTS.md": `${AGENTS}\n${BLOCK}`, "CLAUDE.md": `# Claude\n\n${BLOCK}` };
    await withRepo("keryx-doctor-entry-leftover-mine-", { committed, agentEntrypoints: shared }, async (root) => {
      await writeRel(root, "AGENTS.override.md", "# My own override\n");
      expect((await checkEntrypoints(root)).status).toBe("ok");
    });
  });

  test("the check writes nothing, whatever it finds", async () => {
    await withRepo("keryx-doctor-entry-readonly-", { ...MIGRATED, committed: { "AGENTS.md": AGENTS, ".claude/settings.json": "{}\n", ".gitignore": "x/\n" } }, async (root) => {
      await writeRel(root, "AGENTS.md", `${AGENTS}\n${BLOCK}`);
      await writeRel(root, ".claude/settings.json", MANAGED_HOOKS);
      await writeRel(root, ".gitignore", `x/\n\n${LEGACY_IGNORE_BLOCK}`);
      await writeRel(root, "AGENTS.override.md", renderCodexOverride({ source: "AGENTS.md", sourceContent: "old\n", block: BLOCK }));
      const before = await snapshot(root);
      const status = git(root, ["status", "--porcelain"]);
      await checkEntrypoints(root);
      await buildDoctorReport(root, {});
      expect(await snapshot(root)).toEqual(before);
      expect(git(root, ["status", "--porcelain"])).toBe(status);
    });
  });

  test("buildDoctorReport carries the entrypoints check and never fails on it", async () => {
    await withRepo("keryx-doctor-entry-report-", MIGRATED, async (root) => {
      await writeRel(root, "AGENTS.md", `${AGENTS}\n${BLOCK}`);
      const report = await buildDoctorReport(root, {});
      const check = report.checks.find((entry) => entry.id === "entrypoints");
      expect(check?.status).toBe("warn");
      expect(report.checks.filter((entry) => entry.id === "entrypoints")).toHaveLength(1);
    });
  });
});
