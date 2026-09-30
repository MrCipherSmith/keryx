// Flow 361 T8: every keryx-managed Claude Code hook lives in the file
// `agentEntrypoints.claudeSettings` names, and hooks an older keryx left in
// the tracked `.claude/settings.json` are moved out. Every git fixture below
// is a real temp repository.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { CLAUDE_ORIENT, installOrientRuntime } from "../ctx/orient-runtimes";
import { installRuntimeHook, uninstallRuntimeHook } from "../ctx/hook-install";
import { CLAUDE_RUNTIME as CTX_CLAUDE } from "../ctx/runtimes";
import { agentSettingsPath, installSecurityAgentHooks, uninstallSecurityAgentHooks } from "../security/agent-hooks";
import {
  CLAUDE_LOCAL_SETTINGS_PATH,
  CLAUDE_SHARED_SETTINGS_PATH,
  claudeSettingsRelativePath,
  resolveClaudeSettingsTarget,
} from "./claude-settings";
import { decideClaudeSettingsTarget, moveClaudeSettingsHooks } from "./claude-settings-migration";
import { doctorIntegration, installIntegration, uninstallIntegration } from "./installer";
import { readInstallState } from "./install-state";
import { JEV_EDIT_GUARD_SURFACE } from "./jev-edit-guard-surface";
import { HARNESS_ADAPTERS, assertRegistryCoherent, settingsFileOwnerFor } from "./registry";
import { LEARNING_OBSERVER_CLAUDE } from "./surfaces-learning";
import { CTX_GUARD_CLAUDE, ORIENT_CLAUDE, SECURITY_CHECK_INPUT_CLAUDE, SECURITY_CHECK_OUTPUT_CLAUDE } from "./surfaces";
import type { Settings, SurfaceAdapter } from "./types";

const LOCAL = ".claude/settings.local.json";
const SHARED = ".claude/settings.json";

const ALL_CLAUDE_SURFACES: readonly SurfaceAdapter[] = [
  CTX_GUARD_CLAUDE,
  ORIENT_CLAUDE,
  SECURITY_CHECK_INPUT_CLAUDE,
  SECURITY_CHECK_OUTPUT_CLAUDE,
  LEARNING_OBSERVER_CLAUDE,
  JEV_EDIT_GUARD_SURFACE,
];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content, "utf8");
}

/** A temp project; with `git`, a real repository whose first commit holds `committed`. */
async function project(committed: Record<string, string> = {}, options: { git?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-claude-settings-"));
  for (const [rel, content] of Object.entries(committed)) await put(root, rel, content);
  if (options.git !== false) {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@test.com"]);
    git(root, ["config", "user.name", "test"]);
    await put(root, "README.md", "fixture\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "fixture"]);
  }
  return root;
}

async function manifest(root: string, claudeSettings: unknown): Promise<void> {
  await put(
    root,
    ".metaproject/metaproject.json",
    `${JSON.stringify({ modules: {}, agentEntrypoints: claudeSettings === undefined ? { root: ["AGENTS.md"] } : { root: [], claudeSettings } }, null, 2)}\n`,
  );
}

/** `base` with every Claude surface merged in, as an older keryx wrote them into one file. */
function withEverySurface(base: Settings, surfaces: readonly SurfaceAdapter[] = ALL_CLAUDE_SURFACES): string {
  let settings: Settings = structuredClone(base);
  for (const surface of surfaces) settings = surface.merge!(settings);
  return `${JSON.stringify(settings, null, 2)}\n`;
}

async function readJson(root: string, rel: string): Promise<Settings> {
  return JSON.parse(await readFile(path.join(root, rel), "utf8")) as Settings;
}

type Group = { _keryxManaged?: string; hooks?: Array<{ command?: string }> };

/** `event → command → how many managed groups run it`, across both Claude settings files. */
async function managedCommandCounts(root: string): Promise<Record<string, Record<string, number>>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const rel of [SHARED, LOCAL]) {
    if (!existsSync(path.join(root, rel))) continue;
    const hooks = ((await readJson(root, rel)).hooks ?? {}) as Record<string, Group[]>;
    for (const [event, groups] of Object.entries(hooks)) {
      for (const group of groups) {
        if (typeof group._keryxManaged !== "string") continue;
        for (const hook of group.hooks ?? []) {
          const byCommand = (counts[event] ??= {});
          byCommand[hook.command ?? ""] = (byCommand[hook.command ?? ""] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

function expectEverySurfaceOncePerEvent(counts: Record<string, Record<string, number>>): void {
  for (const byCommand of Object.values(counts)) {
    for (const count of Object.values(byCommand)) expect(count).toBe(1);
  }
  expect(counts.PreToolUse).toEqual({
    "keryx ctx hook claude": 1,
    "keryx security check-output --runtime claude": 1,
    "keryx learn observe --hook claude": 1,
  });
  expect(counts.UserPromptSubmit).toEqual({
    "keryx orient claude": 1,
    "keryx security check-input --source untrusted-external --runtime claude": 1,
    "keryx learn observe --hook claude": 1,
  });
  expect(counts.PostToolUse).toEqual({
    "keryx learn observe --hook claude": 1,
    "keryx review jev-edit-guard --hook claude": 1,
  });
  for (const event of ["PostToolUseFailure", "SessionStart", "Stop", "SessionEnd"]) {
    expect(counts[event]).toEqual({ "keryx learn observe --hook claude": 1 });
  }
}

function hasManaged(text: string): boolean {
  return text.includes("_keryxManaged");
}

function diffIsQuiet(root: string, rel: string): boolean {
  return Bun.spawnSync(["git", "diff", "--quiet", "--", rel], { cwd: root }).exitCode === 0;
}

async function migrate(root: string): Promise<{ scope: string; output: string }> {
  const notices: string[] = [];
  const decision = await decideClaudeSettingsTarget(root);
  notices.push(...decision.notices);
  await moveClaudeSettingsHooks(root, decision.target, (line) => notices.push(line));
  return { scope: decision.target.scope, output: notices.join("\n") };
}

describe("the Claude settings resolver", () => {
  test("names the local file by default, with or without a manifest", async () => {
    const root = await project({}, { git: false });
    try {
      expect(CLAUDE_LOCAL_SETTINGS_PATH).toBe(LOCAL);
      expect(CLAUDE_SHARED_SETTINGS_PATH).toBe(SHARED);
      expect(resolveClaudeSettingsTarget(root)).toEqual({ path: LOCAL, scope: "local" });
      await manifest(root, undefined);
      expect(claudeSettingsRelativePath(root)).toBe(LOCAL);
      await manifest(root, { path: LOCAL, scope: "local" });
      expect(claudeSettingsRelativePath(root)).toBe(LOCAL);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("follows scope shared to .claude/settings.json", async () => {
    const root = await project({}, { git: false });
    try {
      await manifest(root, { path: SHARED, scope: "shared" });
      expect(resolveClaudeSettingsTarget(root)).toEqual({ path: SHARED, scope: "shared" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps writing where managed hooks still are until update has moved them, so nothing fires twice", async () => {
    const root = await project({}, { git: false });
    try {
      await manifest(root, { path: LOCAL, scope: "local" });
      await put(root, SHARED, withEverySurface({}, [SECURITY_CHECK_INPUT_CLAUDE]));
      expect(claudeSettingsRelativePath(root)).toBe(SHARED);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never lets a local entry point at the tracked file, and ignores a path that is neither settings file", async () => {
    const root = await project({}, { git: false });
    try {
      await manifest(root, { path: SHARED, scope: "local" });
      expect(resolveClaudeSettingsTarget(root)).toEqual({ path: LOCAL, scope: "local" });
      await manifest(root, { path: ".claude/other.json", scope: "shared" });
      expect(resolveClaudeSettingsTarget(root)).toEqual({ path: SHARED, scope: "shared" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("every Claude surface resolves its file through the one resolver", () => {
  test("the registry has one coherent owner per Claude settings file, each carrying every Claude surface", () => {
    assertRegistryCoherent();
    const claude = HARNESS_ADAPTERS.find((adapter) => adapter.id === "claude")!;
    const jsonSurfaceIds = claude.surfaces.filter((surface) => surface.merge && surface.strip).map((surface) => surface.id);
    expect(jsonSurfaceIds).toEqual(["ctx-guard", "orient", "security-check-input", "security-check-output", "learning-observer"]);
    for (const rel of [LOCAL, SHARED]) {
      const owner = settingsFileOwnerFor(rel);
      expect(owner?.relativePath).toBe(rel);
      expect(owner?.surfaces().map((surface) => surface.id)).toEqual(jsonSurfaceIds);
    }
  });

  test("a surface left behind on one file alone is a coherence error", () => {
    const claude = HARNESS_ADAPTERS.find((adapter) => adapter.id === "claude")!;
    const stray: SurfaceAdapter = { ...ORIENT_CLAUDE, id: "ctx-guard", relativePath: SHARED, relativePathCandidates: [SHARED] };
    const other = { ...claude, id: "other", surfaces: [stray] };
    expect(() => assertRegistryCoherent([claude, other])).toThrow(/registered by both/);
  });

  test("ctx, orient, security, learning and the generic installer all write the local file in a fresh project", async () => {
    const root = await project({}, { git: false });
    try {
      expect((await installRuntimeHook(root, CTX_CLAUDE)).errors).toEqual([]);
      expect(await installOrientRuntime(root, "claude")).toEqual([]);
      await installSecurityAgentHooks(root);
      expect((await installIntegration(root, "claude", { surfaces: ["learning-observer"] })).errors).toEqual([]);

      expect(existsSync(path.join(root, SHARED))).toBe(false);
      expect(CTX_CLAUDE.locate(root)).toBe(path.join(root, LOCAL));
      expect(CLAUDE_ORIENT.locate(root)).toBe(path.join(root, LOCAL));
      expect(agentSettingsPath(root)).toBe(path.join(root, LOCAL));
      const counts = await managedCommandCounts(root);
      expect(counts.PreToolUse?.["keryx ctx hook claude"]).toBe(1);
      expect(counts.UserPromptSubmit?.["keryx orient claude"]).toBe(1);
      expect(counts.PreToolUse?.["keryx security check-output --runtime claude"]).toBe(1);
      expect(counts.SessionStart?.["keryx learn observe --hook claude"]).toBe(1);

      // Status and uninstall read the same file.
      const doctor = await doctorIntegration(root, "claude", { surfaces: ["learning-observer"] });
      expect(doctor.surfaces.filter((surface) => surface.live !== "valid" && surface.flag !== "agents" && surface.flag !== "rules")).toEqual([]);
      expect(await uninstallRuntimeHook(root, CTX_CLAUDE)).toBe(true);
      expect(await uninstallSecurityAgentHooks(root)).toBe(true);
      const removed = await uninstallIntegration(root, "claude", { surfaces: ["orient", "learning-observer"] });
      expect(removed.results.map((result) => [result.file, result.status])).toEqual([
        [LOCAL, "removed"],
        [LOCAL, "removed"],
      ]);
      expect(hasManaged(await readFile(path.join(root, LOCAL), "utf8"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scope shared still writes .claude/settings.json, and install-state names that path", async () => {
    const root = await project({}, { git: false });
    try {
      await manifest(root, { path: SHARED, scope: "shared" });
      await installRuntimeHook(root, CTX_CLAUDE);
      await installOrientRuntime(root, "claude");
      await installSecurityAgentHooks(root);

      expect(existsSync(path.join(root, LOCAL))).toBe(false);
      expect(hasManaged(await readFile(path.join(root, SHARED), "utf8"))).toBe(true);
      const state = await readInstallState(root, "claude");
      expect(state?.installedModules.map((record) => record.writtenPaths)).toEqual([[SHARED], [SHARED], [SHARED], [SHARED]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("install-state names the local path under local scope", async () => {
    const root = await project({}, { git: false });
    try {
      await manifest(root, { path: LOCAL, scope: "local" });
      await installSecurityAgentHooks(root);
      const state = await readInstallState(root, "claude");
      expect(state?.installedModules.map((record) => record.writtenPaths)).toEqual([[LOCAL], [LOCAL]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("other runtimes keep their own files", async () => {
    const root = await project({}, { git: false });
    try {
      for (const runtime of ["codex", "cursor", "windsurf", "gemini-cli", "generic-mcp"]) {
        expect((await installIntegration(root, runtime, { surfaces: [], lenientSelectors: true })).errors).toEqual([]);
      }
      for (const rel of [".codex/hooks.json", ".cursor/hooks.json", ".windsurf/hooks.json", ".gemini/settings.json", ".mcp/security-hooks.json"]) {
        expect(existsSync(path.join(root, rel))).toBe(true);
      }
      expect(existsSync(path.join(root, ".claude"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("moving managed hooks out of the tracked .claude/settings.json", () => {
  // Hand formatting a JSON re-serialisation would not reproduce.
  const TEAM_SETTINGS = '{\n    "model": "sonnet",\n    "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "team-audit" } ] } ] }\n}\n';

  test("(b) uncommitted managed hooks: every surface lands in the local file once, the tracked file is restored to HEAD bytes", async () => {
    const root = await project({ [SHARED]: TEAM_SETTINGS });
    try {
      await put(root, SHARED, withEverySurface(JSON.parse(TEAM_SETTINGS) as Settings));
      expect(diffIsQuiet(root, SHARED)).toBe(false);

      const { scope, output } = await migrate(root);

      expect(scope).toBe("local");
      expect(await readFile(path.join(root, SHARED), "utf8")).toBe(TEAM_SETTINGS);
      expect(diffIsQuiet(root, SHARED)).toBe(true);
      expectEverySurfaceOncePerEvent(await managedCommandCounts(root));
      expect(hasManaged(await readFile(path.join(root, LOCAL), "utf8"))).toBe(true);
      expect((await readJson(root, LOCAL))._keryxManaged).toEqual([
        "ctx-agent-hooks",
        "ctx-orient-hooks",
        "security-agent-hooks",
        "learning-observer-hooks",
        "jev-edit-guard-hooks",
      ]);
      // The team's own hook stays where the team put it.
      expect(JSON.stringify(await readJson(root, LOCAL))).not.toContain("team-audit");
      expect(output).toContain(`${SHARED}: moved the keryx-managed hooks to ${LOCAL}; the file is back at HEAD.`);
      expect(claudeSettingsRelativePath(root)).toBe(LOCAL);

      // A second run has nothing to do.
      const before = await readFile(path.join(root, LOCAL));
      expect((await migrate(root)).output).toBe("");
      expect((await readFile(path.join(root, LOCAL))).equals(before)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("(a) managed hooks committed in HEAD: scope becomes shared, nothing is touched, and the output says how to switch", async () => {
    const committed = withEverySurface(JSON.parse(TEAM_SETTINGS) as Settings);
    const root = await project({ [SHARED]: committed });
    try {
      await manifest(root, { path: LOCAL, scope: "local" });

      const { scope, output } = await migrate(root);

      expect(scope).toBe("shared");
      expect(await readFile(path.join(root, SHARED), "utf8")).toBe(committed);
      expect(diffIsQuiet(root, SHARED)).toBe(true);
      expect(existsSync(path.join(root, LOCAL))).toBe(false);
      expect(output).toContain(`${SHARED}: keryx-managed hooks are committed in HEAD`);
      expect(output).toContain('"shared"');
      expect(output).toContain("keryx update");
      // Every installer follows: nothing is installed into the local file.
      await installSecurityAgentHooks(root);
      expect(existsSync(path.join(root, LOCAL))).toBe(false);
      expectEverySurfaceOncePerEvent(await managedCommandCounts(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("(c) other uncommitted edits: only keryx's groups and its own top-level keys go, and the file is named", async () => {
    const root = await project({ [SHARED]: TEAM_SETTINGS });
    try {
      const edited = JSON.parse(TEAM_SETTINGS) as { hooks: Record<string, unknown[]> } & Settings;
      edited.env = { MY_FLAG: "1" };
      edited.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: "my-uncommitted-logger" }] }];
      await put(root, SHARED, withEverySurface(edited));

      const { output } = await migrate(root);

      expect(await readJson(root, SHARED)).toEqual(edited);
      expect(hasManaged(await readFile(path.join(root, SHARED), "utf8"))).toBe(false);
      expectEverySurfaceOncePerEvent(await managedCommandCounts(root));
      expect(output).toContain(`${SHARED}: removed the keryx-managed hooks`);
      expect(output).toContain(`your other uncommitted edits in ${SHARED} are kept`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("(b) is decided on parsed content: a file that differs from HEAD only by keryx's groups and formatting is restored", async () => {
    const root = await project({ [SHARED]: '{"permissions":{"allow":["Bash(ls:*)"]},"hooks":{}}\n' });
    try {
      await put(root, SHARED, withEverySurface({ permissions: { allow: ["Bash(ls:*)"] } }));
      await migrate(root);
      expect(await readFile(path.join(root, SHARED), "utf8")).toBe('{"permissions":{"allow":["Bash(ls:*)"]},"hooks":{}}\n');
      expect(diffIsQuiet(root, SHARED)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("(d) a settings.json that is not in HEAD and holds only keryx's content is removed", async () => {
    const root = await project();
    try {
      await put(root, SHARED, withEverySurface({}));

      const { output } = await migrate(root);

      expect(existsSync(path.join(root, SHARED))).toBe(false);
      expect(git(root, ["status", "--porcelain"])).not.toContain("settings.json");
      expectEverySurfaceOncePerEvent(await managedCommandCounts(root));
      expect(output).toContain(`${SHARED}: removed the file`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("(d) a settings.json that is not in HEAD but holds the user's own keys, or is staged, stays without keryx's content", async () => {
    const withUserKey = await project();
    const staged = await project();
    try {
      await put(withUserKey, SHARED, withEverySurface({ model: "opus" }));
      const first = await migrate(withUserKey);
      expect(await readJson(withUserKey, SHARED)).toEqual({ model: "opus" });
      expect(first.output).toContain(`${SHARED}: removed the keryx-managed hooks`);
      expect(first.output).toContain("untracked");

      await put(staged, SHARED, withEverySurface({}));
      git(staged, ["add", "--", SHARED]);
      await migrate(staged);
      expect(await readJson(staged, SHARED)).toEqual({});
    } finally {
      await rm(withUserKey, { recursive: true, force: true });
      await rm(staged, { recursive: true, force: true });
    }
  });

  test("the user's own content in an existing settings.local.json is kept and keryx merges into it", async () => {
    const root = await project({ [SHARED]: TEAM_SETTINGS });
    try {
      const mine = {
        permissions: { allow: ["Bash(bun test:*)"] },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-local-hook" }] }] },
      };
      await put(root, LOCAL, `${JSON.stringify(mine, null, 2)}\n`);
      await put(root, SHARED, withEverySurface(JSON.parse(TEAM_SETTINGS) as Settings));

      await migrate(root);

      const local = (await readJson(root, LOCAL)) as typeof mine & Settings;
      expect(local.permissions).toEqual(mine.permissions);
      expect(local.hooks.PreToolUse[0]).toEqual(mine.hooks.PreToolUse[0]!);
      expectEverySurfaceOncePerEvent(await managedCommandCounts(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a surface already in the local file is not doubled, and a partial install is moved as it was", async () => {
    const root = await project({ [SHARED]: TEAM_SETTINGS });
    try {
      // The user kept check-output only, and had already installed ctx locally.
      await put(root, SHARED, withEverySurface(JSON.parse(TEAM_SETTINGS) as Settings, [CTX_GUARD_CLAUDE, SECURITY_CHECK_OUTPUT_CLAUDE]));
      await put(root, LOCAL, withEverySurface({}, [CTX_GUARD_CLAUDE]));

      await migrate(root);

      const counts = await managedCommandCounts(root);
      expect(counts.PreToolUse).toEqual({ "keryx ctx hook claude": 1, "keryx security check-output --runtime claude": 1 });
      expect(counts.UserPromptSubmit).toBeUndefined();
      expect(diffIsQuiet(root, SHARED)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("outside a git repository the hooks move to the resolved target, the other file is cleaned, and the output says so", async () => {
    const root = await project({}, { git: false });
    try {
      await put(root, SHARED, withEverySurface({ model: "sonnet" }));

      const { scope, output } = await migrate(root);

      expect(scope).toBe("local");
      expect(await readJson(root, SHARED)).toEqual({ model: "sonnet" });
      expectEverySurfaceOncePerEvent(await managedCommandCounts(root));
      expect(output).toContain("Not a git repository");
      const before = await readFile(path.join(root, LOCAL));
      expect((await migrate(root)).output).toBe("");
      expect((await readFile(path.join(root, LOCAL))).equals(before)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("scope shared pulls hooks left in the local file back into settings.json", async () => {
    const root = await project({ [SHARED]: TEAM_SETTINGS });
    try {
      await manifest(root, { path: SHARED, scope: "shared" });
      await put(root, LOCAL, withEverySurface({ permissions: { allow: [] } }));

      const { scope } = await migrate(root);

      expect(scope).toBe("shared");
      expect(await readJson(root, LOCAL)).toEqual({ permissions: { allow: [] } });
      expectEverySurfaceOncePerEvent(await managedCommandCounts(root));
      expect(JSON.stringify(await readJson(root, SHARED))).toContain("team-audit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("install-state follows the hooks to the new path and is not rewritten by a second run", async () => {
    const root = await project({ [SHARED]: TEAM_SETTINGS });
    try {
      await manifest(root, { path: SHARED, scope: "shared" });
      await installRuntimeHook(root, CTX_CLAUDE);
      await installSecurityAgentHooks(root);
      await manifest(root, { path: LOCAL, scope: "local" });
      const statePath = path.join(root, ".metaproject", "data", "integrations", "install-state", "claude.json");
      expect(await readFile(statePath, "utf8")).toContain(`"${SHARED}"`);

      await migrate(root);

      const state = await readInstallState(root, "claude");
      expect(state?.installedModules.map((record) => record.writtenPaths)).toEqual([[LOCAL], [LOCAL], [LOCAL]]);
      const before = await readFile(statePath);
      await migrate(root);
      await installSecurityAgentHooks(root);
      expect((await readFile(statePath)).equals(before)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
